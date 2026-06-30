import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  recommendations,
  findings,
  workspaces,
  pipelines,
  activity_log,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function ownsWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  return !!ws && ws.owner_id === userId
}

/** Map a finding's detector to a remediation recommendation shape. */
function recommendationForFinding(f: typeof findings.$inferSelect): {
  kind: string
  title: string
  detail: string
  suggested_diff: string
  risk_delta: number
} {
  const evidence = (f.evidence ?? {}) as Record<string, unknown>
  switch (f.detector) {
    case 'over_privilege': {
      const recommended = (evidence.recommended_permissions as Record<string, string>) ?? {
        contents: 'read',
      }
      const lines = Object.entries(recommended)
        .map(([k, v]) => `+  ${k}: ${v}`)
        .join('\n')
      return {
        kind: 'least_privilege',
        title: `Tighten permissions for "${f.title}"`,
        detail:
          'Replace broad/wildcard permissions with the minimal set actually exercised by this pipeline.',
        suggested_diff: `permissions:\n${lines || '+  contents: read'}`,
        risk_delta: -12,
      }
    }
    case 'action_risk': {
      const action = (evidence.action as string) ?? 'third-party action'
      const sha = (evidence.recommended_sha as string) ?? '<commit-sha>'
      return {
        kind: 'pin_upgrade',
        title: `Pin ${action} to a commit SHA`,
        detail:
          'Replace mutable tag/branch references with an immutable commit SHA to prevent supply-chain tampering.',
        suggested_diff: `-  uses: ${action}@main\n+  uses: ${action}@${sha}`,
        risk_delta: -8,
      }
    }
    case 'secret': {
      const secretName = (evidence.secret as string) ?? 'SECRET'
      return {
        kind: 'secret_rotation',
        title: `Rotate and scope secret ${secretName}`,
        detail:
          'Rotate the credential, enable masking, scope it to the environment that needs it, and remove fork-PR exposure.',
        suggested_diff: `# Rotate ${secretName} in the provider secret store\n# Enable masking + environment scoping`,
        risk_delta: -10,
      }
    }
    case 'drift': {
      return {
        kind: 'least_privilege',
        title: `Review drift: "${f.title}"`,
        detail: 'Revert or approve the detected configuration change to restore the approved baseline posture.',
        suggested_diff: '# Revert the drifted change or approve it as the new baseline',
        risk_delta: -5,
      }
    }
    case 'blast_radius': {
      return {
        kind: 'least_privilege',
        title: `Reduce blast radius for "${f.title}"`,
        detail:
          'Segment access so this pipeline can no longer reach crown-jewel resources; split roles and remove cross-pipeline reachability.',
        suggested_diff: '# Split the over-scoped role; remove crown-jewel grants',
        risk_delta: -15,
      }
    }
    default: {
      return {
        kind: 'trust_tighten',
        title: `Remediate "${f.title}"`,
        detail: f.description || 'Address the underlying finding to reduce risk.',
        suggested_diff: '# Apply least-privilege remediation',
        risk_delta: -6,
      }
    }
  }
}

const generateSchema = z.object({
  workspace_id: z.string().min(1),
})

// ---------------------------------------------------------------------------
// GET / — list recommendations (public)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const status = c.req.query('status')
  const conds = []
  if (workspaceId) conds.push(eq(recommendations.workspace_id, workspaceId))
  if (status) conds.push(eq(recommendations.status, status))
  const rows = conds.length
    ? await db
        .select()
        .from(recommendations)
        .where(and(...conds))
        .orderBy(desc(recommendations.created_at))
    : await db.select().from(recommendations).orderBy(desc(recommendations.created_at))
  return c.json(rows)
})

// ---------------------------------------------------------------------------
// POST /generate — derive recommendations from open findings
// ---------------------------------------------------------------------------

router.post('/generate', authMiddleware, zValidator('json', generateSchema), async (c) => {
  const userId = getUserId(c)
  const { workspace_id } = c.req.valid('json')
  if (!(await ownsWorkspace(workspace_id, userId)))
    return c.json({ error: 'Forbidden' }, 403)

  // Only act on findings that are still actionable.
  const openFindings = await db
    .select()
    .from(findings)
    .where(eq(findings.workspace_id, workspace_id))

  // Existing open recommendations keyed by finding so we don't duplicate.
  const existing = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.workspace_id, workspace_id))
  const haveOpenForFinding = new Set(
    existing
      .filter((r) => r.status === 'open' && r.finding_id)
      .map((r) => r.finding_id as string),
  )

  let created = 0
  for (const f of openFindings) {
    if (f.status === 'remediated' || f.status === 'suppressed') continue
    if (haveOpenForFinding.has(f.id)) continue
    const rec = recommendationForFinding(f)
    await db.insert(recommendations).values({
      workspace_id,
      pipeline_id: f.pipeline_id ?? null,
      finding_id: f.id,
      kind: rec.kind,
      title: rec.title,
      detail: rec.detail,
      suggested_diff: rec.suggested_diff,
      risk_delta: rec.risk_delta,
      status: 'open',
    })
    created++
  }

  await db.insert(activity_log).values({
    workspace_id,
    actor_id: userId,
    action: 'recommendations.generate',
    entity_type: 'recommendation',
    entity_id: '',
    metadata: { created },
  })

  return c.json({ created })
})

// ---------------------------------------------------------------------------
// POST /:id/apply — mark applied + capture evidence
// ---------------------------------------------------------------------------

router.post('/:id/apply', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [rec] = await db.select().from(recommendations).where(eq(recommendations.id, id))
  if (!rec) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(rec.workspace_id, userId)))
    return c.json({ error: 'Forbidden' }, 403)

  const appliedAt = new Date()
  const [updated] = await db
    .update(recommendations)
    .set({ status: 'applied', applied_by: userId, applied_at: appliedAt })
    .where(eq(recommendations.id, id))
    .returning()

  // Mark the originating finding remediated and record evidence of the action.
  if (rec.finding_id) {
    const [f] = await db.select().from(findings).where(eq(findings.id, rec.finding_id))
    if (f) {
      const prevEvidence = (f.evidence ?? {}) as Record<string, unknown>
      await db
        .update(findings)
        .set({
          status: 'remediated',
          updated_at: appliedAt,
          evidence: {
            ...prevEvidence,
            applied_recommendation_id: rec.id,
            applied_by: userId,
            applied_at: appliedAt.toISOString(),
          },
        })
        .where(eq(findings.id, rec.finding_id))
    }
  }

  await db.insert(activity_log).values({
    workspace_id: rec.workspace_id,
    actor_id: userId,
    action: 'recommendation.apply',
    entity_type: 'recommendation',
    entity_id: rec.id,
    metadata: { finding_id: rec.finding_id, risk_delta: rec.risk_delta },
  })

  return c.json(updated)
})

// ---------------------------------------------------------------------------
// POST /:id/dismiss — dismiss a recommendation
// ---------------------------------------------------------------------------

router.post('/:id/dismiss', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [rec] = await db.select().from(recommendations).where(eq(recommendations.id, id))
  if (!rec) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(rec.workspace_id, userId)))
    return c.json({ error: 'Forbidden' }, 403)

  const [updated] = await db
    .update(recommendations)
    .set({ status: 'dismissed' })
    .where(eq(recommendations.id, id))
    .returning()

  await db.insert(activity_log).values({
    workspace_id: rec.workspace_id,
    actor_id: userId,
    action: 'recommendation.dismiss',
    entity_type: 'recommendation',
    entity_id: rec.id,
    metadata: {},
  })

  return c.json(updated)
})

export default router
