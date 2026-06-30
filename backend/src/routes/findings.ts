import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  workspaces,
  pipelines,
  pipeline_identities,
  pipeline_actions,
  actions,
  effective_permissions,
  secrets,
  secret_references,
  blast_radius,
  findings,
  recommendations,
} from '../db/schema.js'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

async function ownsWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  if (!workspaceId || !userId) return false
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  return !!ws && ws.owner_id === userId
}

type Severity = 'critical' | 'high' | 'medium' | 'low'

interface DetectedFinding {
  pipeline_id: string | null
  detector: string
  title: string
  description: string
  severity: Severity
  evidence: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Detectors — each returns a list of would-be findings for the workspace.
// ---------------------------------------------------------------------------

/** over_privilege: effective permissions flagged as excess, or wildcard write-all. */
async function detectOverPrivilege(workspaceId: string): Promise<DetectedFinding[]> {
  const out: DetectedFinding[] = []
  const wsPipelines = await db
    .select()
    .from(pipelines)
    .where(eq(pipelines.workspace_id, workspaceId))
  for (const p of wsPipelines) {
    const effs = await db
      .select()
      .from(effective_permissions)
      .where(eq(effective_permissions.pipeline_id, p.id))
    const excess = effs.filter((e) => e.is_excess)
    if (excess.length > 0) {
      out.push({
        pipeline_id: p.id,
        detector: 'over_privilege',
        title: `Over-privileged pipeline: ${p.name}`,
        description: `Pipeline grants ${excess.length} effective permission(s) beyond what its steps require.`,
        severity: excess.length >= 5 ? 'high' : 'medium',
        evidence: { excess_actions: excess.map((e) => e.action), count: excess.length },
      })
    }
    // contents: write-all / permissions: write declared on the pipeline.
    const declared = (p.declared_permissions ?? {}) as Record<string, string>
    const writeAll = Object.entries(declared).filter(
      ([k, v]) => (k === 'contents' || k === 'permissions' || k === 'id-token') && v === 'write',
    )
    if (writeAll.length > 0) {
      out.push({
        pipeline_id: p.id,
        detector: 'over_privilege',
        title: `Broad write scopes on ${p.name}`,
        description: `Pipeline declares write access to sensitive scopes: ${writeAll.map(([k]) => k).join(', ')}.`,
        severity: writeAll.some(([k]) => k === 'permissions') ? 'high' : 'medium',
        evidence: { scopes: Object.fromEntries(writeAll) },
      })
    }
  }
  return out
}

/** action_risk: third-party actions pinned to mutable refs or from unverified publishers. */
async function detectActionRisk(workspaceId: string): Promise<DetectedFinding[]> {
  const out: DetectedFinding[] = []
  const wsActions = await db.select().from(actions).where(eq(actions.workspace_id, workspaceId))
  const actionMap = new Map(wsActions.map((a) => [a.id, a]))
  const pas = await db
    .select()
    .from(pipeline_actions)
    .where(eq(pipeline_actions.workspace_id, workspaceId))
  for (const pa of pas) {
    const a = actionMap.get(pa.action_id)
    if (!a) continue
    const issues: string[] = []
    let severity: Severity = 'low'
    if (a.pin_type !== 'sha') {
      issues.push(`pinned to a mutable ${a.pin_type} (${a.pin_ref || 'unspecified'}) instead of a commit SHA`)
      severity = 'high'
    }
    if (!a.is_verified_publisher) {
      issues.push('unverified publisher')
      if (severity === 'low') severity = 'medium'
    }
    if (a.is_deprecated) {
      issues.push('deprecated action')
      if (severity === 'low') severity = 'medium'
    }
    if (issues.length === 0) continue
    if (a.risk_level === 'critical') severity = 'critical'
    out.push({
      pipeline_id: pa.pipeline_id,
      detector: 'action_risk',
      title: `Risky action ${a.name}@${a.pin_ref || '?'}`,
      description: `Step "${pa.step_name || 'unnamed'}" uses ${a.name}: ${issues.join('; ')}.`,
      severity,
      evidence: {
        action: a.name,
        pin_type: a.pin_type,
        pin_ref: a.pin_ref,
        verified_publisher: a.is_verified_publisher,
        inherited_privileges: a.inherited_privileges,
        step_name: pa.step_name,
      },
    })
  }
  return out
}

/** secret: plaintext, unmasked, fork-PR exposed, or overdue-for-rotation secrets. */
async function detectSecrets(workspaceId: string): Promise<DetectedFinding[]> {
  const out: DetectedFinding[] = []
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  const maxAge = ws?.rotation_age_days ?? 90
  const wsSecrets = await db.select().from(secrets).where(eq(secrets.workspace_id, workspaceId))
  for (const s of wsSecrets) {
    // Find a pipeline that references this secret (for attribution).
    const [ref] = await db
      .select()
      .from(secret_references)
      .where(eq(secret_references.secret_id, s.id))
    const pipelineId = ref?.pipeline_id ?? null

    if (s.is_plaintext) {
      out.push({
        pipeline_id: pipelineId,
        detector: 'secret',
        title: `Plaintext secret: ${s.name}`,
        description: `Secret "${s.name}" is stored in plaintext (store=${s.store}).`,
        severity: 'critical',
        evidence: { secret: s.name, store: s.store },
      })
    }
    if (s.exposed_to_fork_pr) {
      out.push({
        pipeline_id: pipelineId,
        detector: 'secret',
        title: `Secret exposed to fork PRs: ${s.name}`,
        description: `Secret "${s.name}" is reachable from pull_request_target / fork workflows.`,
        severity: 'high',
        evidence: { secret: s.name },
      })
    }
    if (!s.is_masked) {
      out.push({
        pipeline_id: pipelineId,
        detector: 'secret',
        title: `Unmasked secret: ${s.name}`,
        description: `Secret "${s.name}" is not masked in logs.`,
        severity: 'medium',
        evidence: { secret: s.name },
      })
    }
    if ((s.rotation_age_days ?? 0) > maxAge) {
      out.push({
        pipeline_id: pipelineId,
        detector: 'secret',
        title: `Overdue secret rotation: ${s.name}`,
        description: `Secret "${s.name}" is ${s.rotation_age_days} days old (policy max ${maxAge}).`,
        severity: (s.rotation_age_days ?? 0) > maxAge * 2 ? 'high' : 'medium',
        evidence: { secret: s.name, age_days: s.rotation_age_days, max_age_days: maxAge },
      })
    }
  }
  return out
}

/** blast_radius: pipelines with a high computed blast-radius score or crown-jewel reach. */
async function detectBlastRadius(workspaceId: string): Promise<DetectedFinding[]> {
  const out: DetectedFinding[] = []
  const rows = await db
    .select()
    .from(blast_radius)
    .where(eq(blast_radius.workspace_id, workspaceId))
  for (const b of rows) {
    if (b.score >= 50 || b.crown_jewel_count > 0) {
      out.push({
        pipeline_id: b.pipeline_id,
        detector: 'blast_radius',
        title: `High blast radius (score ${b.score})`,
        description: b.summary || `Pipeline reaches ${b.crown_jewel_count} crown jewel(s).`,
        severity: b.crown_jewel_count > 0 ? 'critical' : b.score >= 75 ? 'high' : 'medium',
        evidence: {
          score: b.score,
          crown_jewel_count: b.crown_jewel_count,
          reachable_resources: b.reachable_resource_ids,
          reachable_secrets: b.reachable_secret_ids,
        },
      })
    }
  }
  return out
}

/** long-lived credentials / non-OIDC identities. */
async function detectIdentityRisk(workspaceId: string): Promise<DetectedFinding[]> {
  const out: DetectedFinding[] = []
  const idents = await db
    .select()
    .from(pipeline_identities)
    .where(eq(pipeline_identities.workspace_id, workspaceId))
  for (const i of idents) {
    if (i.is_long_lived) {
      out.push({
        pipeline_id: i.pipeline_id,
        detector: 'over_privilege',
        title: `Long-lived credential: ${i.name}`,
        description: `Identity "${i.name}" (${i.identity_type}) uses a long-lived credential; prefer short-lived OIDC.`,
        severity: 'high',
        evidence: { identity: i.name, type: i.identity_type, credential_kind: i.credential_kind },
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// GET / — list findings with optional filters
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  if (!workspaceId) return c.json({ error: 'workspace_id is required' }, 400)
  const detector = c.req.query('detector')
  const severity = c.req.query('severity')
  const status = c.req.query('status')

  const conds = [eq(findings.workspace_id, workspaceId)]
  if (detector) conds.push(eq(findings.detector, detector))
  if (severity) conds.push(eq(findings.severity, severity))
  if (status) conds.push(eq(findings.status, status))

  const rows = await db
    .select()
    .from(findings)
    .where(conds.length === 1 ? conds[0] : and(...conds))
    .orderBy(desc(findings.created_at))
  return c.json(rows)
})

// ---------------------------------------------------------------------------
// GET /:id — finding detail with linked recommendations
// ---------------------------------------------------------------------------

router.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [finding] = await db.select().from(findings).where(eq(findings.id, id))
  if (!finding) return c.json({ error: 'Not found' }, 404)
  const recs = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.finding_id, id))
    .orderBy(desc(recommendations.created_at))
  return c.json({ ...finding, recommendations: recs })
})

// ---------------------------------------------------------------------------
// POST / — create a finding manually
// ---------------------------------------------------------------------------

const createSchema = z.object({
  workspace_id: z.string().min(1),
  pipeline_id: z.string().optional(),
  detector: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional().default(''),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional().default('medium'),
  evidence: z.record(z.unknown()).optional().default({}),
  assignee: z.string().optional().default(''),
})

router.post('/', authMiddleware, zValidator('json', createSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')
  if (!(await ownsWorkspace(body.workspace_id, userId))) return c.json({ error: 'Forbidden' }, 403)
  const [created] = await db
    .insert(findings)
    .values({
      workspace_id: body.workspace_id,
      pipeline_id: body.pipeline_id ?? null,
      detector: body.detector,
      title: body.title,
      description: body.description,
      severity: body.severity,
      evidence: body.evidence,
      assignee: body.assignee,
      created_by: userId,
    })
    .returning()
  return c.json(created, 201)
})

// ---------------------------------------------------------------------------
// POST /scan — run all detectors for a workspace, upsert findings
// ---------------------------------------------------------------------------

const scanSchema = z.object({ workspace_id: z.string().min(1) })

router.post('/scan', authMiddleware, zValidator('json', scanSchema), async (c) => {
  const userId = getUserId(c)
  const { workspace_id } = c.req.valid('json')
  if (!(await ownsWorkspace(workspace_id, userId))) return c.json({ error: 'Forbidden' }, 403)

  const detected: DetectedFinding[] = [
    ...(await detectOverPrivilege(workspace_id)),
    ...(await detectActionRisk(workspace_id)),
    ...(await detectSecrets(workspace_id)),
    ...(await detectBlastRadius(workspace_id)),
    ...(await detectIdentityRisk(workspace_id)),
  ]

  // Existing findings for de-duplication: keyed by (detector, title, pipeline_id).
  const existing = await db
    .select()
    .from(findings)
    .where(eq(findings.workspace_id, workspace_id))
  const seen = new Set(
    existing.map((f) => `${f.detector}::${f.title}::${f.pipeline_id ?? ''}`),
  )

  let created = 0
  for (const d of detected) {
    const key = `${d.detector}::${d.title}::${d.pipeline_id ?? ''}`
    if (seen.has(key)) continue
    await db.insert(findings).values({
      workspace_id,
      pipeline_id: d.pipeline_id,
      detector: d.detector,
      title: d.title,
      description: d.description,
      severity: d.severity,
      evidence: d.evidence,
      created_by: userId,
    })
    seen.add(key)
    created++
  }

  return c.json({ created })
})

// ---------------------------------------------------------------------------
// PUT /:id — update status / assignee / severity / suppress_reason
// ---------------------------------------------------------------------------

const updateSchema = z
  .object({
    status: z.enum(['open', 'acknowledged', 'remediated', 'suppressed']).optional(),
    assignee: z.string().optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    suppress_reason: z.string().optional(),
    due_date: z.string().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' })

router.put('/:id', authMiddleware, zValidator('json', updateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(findings).where(eq(findings.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const patch: Partial<typeof findings.$inferInsert> = { updated_at: new Date() }
  if (body.status !== undefined) patch.status = body.status
  if (body.assignee !== undefined) patch.assignee = body.assignee
  if (body.severity !== undefined) patch.severity = body.severity
  if (body.suppress_reason !== undefined) patch.suppress_reason = body.suppress_reason
  if (body.due_date !== undefined) patch.due_date = body.due_date ? new Date(body.due_date) : null

  const [updated] = await db.update(findings).set(patch).where(eq(findings.id, id)).returning()
  return c.json(updated)
})

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------

router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(findings).where(eq(findings.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) return c.json({ error: 'Forbidden' }, 403)
  // Detach any recommendations that reference this finding before deletion.
  await db
    .update(recommendations)
    .set({ finding_id: null })
    .where(eq(recommendations.finding_id, id))
  await db.delete(findings).where(eq(findings.id, id))
  return c.json({ success: true })
})

export default router
