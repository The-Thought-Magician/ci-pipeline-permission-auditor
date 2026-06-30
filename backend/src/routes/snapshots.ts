import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  snapshots,
  workspaces,
  pipelines,
  findings,
  pipeline_identities,
  oidc_trusts,
  actions,
  pipeline_actions,
  secrets,
  effective_permissions,
  activity_log,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

async function ownsWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  return !!ws && ws.owner_id === userId
}

/**
 * Capture a deterministic posture snapshot of a workspace: counts plus a
 * fingerprint of each pipeline's declared permissions, identities, actions and
 * secret exposure. Stored so drift detection can diff two snapshots later.
 */
async function capturePosture(workspaceId: string): Promise<{
  posture: Record<string, unknown>
  pipeline_count: number
  finding_count: number
}> {
  const wsPipelines = await db
    .select()
    .from(pipelines)
    .where(eq(pipelines.workspace_id, workspaceId))
  const wsFindings = await db
    .select()
    .from(findings)
    .where(eq(findings.workspace_id, workspaceId))
  const wsIdentities = await db
    .select()
    .from(pipeline_identities)
    .where(eq(pipeline_identities.workspace_id, workspaceId))
  const wsTrusts = await db
    .select()
    .from(oidc_trusts)
    .where(eq(oidc_trusts.workspace_id, workspaceId))
  const wsActions = await db.select().from(actions).where(eq(actions.workspace_id, workspaceId))
  const wsPipelineActions = await db
    .select()
    .from(pipeline_actions)
    .where(eq(pipeline_actions.workspace_id, workspaceId))
  const wsSecrets = await db.select().from(secrets).where(eq(secrets.workspace_id, workspaceId))
  const wsEffective = await db
    .select()
    .from(effective_permissions)
    .where(eq(effective_permissions.workspace_id, workspaceId))

  const actionById = new Map(wsActions.map((a) => [a.id, a]))
  const identitiesByPipeline = new Map<string, typeof wsIdentities>()
  for (const i of wsIdentities) {
    const arr = identitiesByPipeline.get(i.pipeline_id) ?? []
    arr.push(i)
    identitiesByPipeline.set(i.pipeline_id, arr)
  }
  const trustByIdentity = new Map(wsTrusts.map((t) => [t.identity_id ?? '', t]))
  const actionsByPipeline = new Map<string, string[]>()
  for (const pa of wsPipelineActions) {
    const a = actionById.get(pa.action_id)
    const ref = a ? `${a.name}@${a.pin_type}:${a.pin_ref}` : pa.action_id
    const arr = actionsByPipeline.get(pa.pipeline_id) ?? []
    arr.push(ref)
    actionsByPipeline.set(pa.pipeline_id, arr)
  }
  const effectiveByPipeline = new Map<string, string[]>()
  for (const e of wsEffective) {
    const arr = effectiveByPipeline.get(e.pipeline_id) ?? []
    arr.push(`${e.category}:${e.action}${e.is_excess ? '!' : ''}`)
    effectiveByPipeline.set(e.pipeline_id, arr)
  }

  const pipelinePosture = wsPipelines
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => ({
      pipeline_id: p.id,
      name: p.name,
      repo: p.repo,
      branch: p.branch,
      risk_score: p.risk_score ?? 0,
      declared_permissions: p.declared_permissions ?? {},
      identities: (identitiesByPipeline.get(p.id) ?? [])
        .map((i) => ({
          name: i.name,
          identity_type: i.identity_type,
          is_long_lived: i.is_long_lived,
          branch_scoped_trust: i.id
            ? trustByIdentity.get(i.id)?.is_branch_scoped ?? null
            : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      actions: (actionsByPipeline.get(p.id) ?? []).sort(),
      effective_permissions: (effectiveByPipeline.get(p.id) ?? []).sort(),
    }))

  const findingMix: Record<string, number> = {}
  for (const f of wsFindings) {
    if (f.status === 'open' || f.status === 'acknowledged') {
      findingMix[f.severity] = (findingMix[f.severity] ?? 0) + 1
    }
  }

  const secretPosture = wsSecrets
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({
      name: s.name,
      store: s.store,
      is_masked: s.is_masked,
      is_plaintext: s.is_plaintext,
      exposed_to_fork_pr: s.exposed_to_fork_pr,
      rotation_age_days: s.rotation_age_days ?? 0,
    }))

  return {
    posture: {
      pipelines: pipelinePosture,
      secrets: secretPosture,
      finding_mix: findingMix,
      avg_risk_score:
        wsPipelines.length > 0
          ? wsPipelines.reduce((sum, p) => sum + (p.risk_score ?? 0), 0) / wsPipelines.length
          : 0,
    },
    pipeline_count: wsPipelines.length,
    finding_count: wsFindings.filter(
      (f) => f.status === 'open' || f.status === 'acknowledged',
    ).length,
  }
}

const createSchema = z.object({
  workspace_id: z.string().min(1),
  label: z.string().min(1),
  is_baseline: z.boolean().optional().default(false),
})

const baselineSchema = z
  .object({
    is_baseline: z.boolean().optional(),
  })
  .optional()

// ---------------------------------------------------------------------------
// GET / — list snapshots (public)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const rows = workspaceId
    ? await db
        .select()
        .from(snapshots)
        .where(eq(snapshots.workspace_id, workspaceId))
        .orderBy(desc(snapshots.created_at))
    : await db.select().from(snapshots).orderBy(desc(snapshots.created_at))
  return c.json(rows)
})

// ---------------------------------------------------------------------------
// GET /:id — snapshot detail (public)
// ---------------------------------------------------------------------------

router.get('/:id', async (c) => {
  const [s] = await db.select().from(snapshots).where(eq(snapshots.id, c.req.param('id')))
  if (!s) return c.json({ error: 'Not found' }, 404)
  return c.json(s)
})

// ---------------------------------------------------------------------------
// POST / — create snapshot, capturing current posture
// ---------------------------------------------------------------------------

router.post('/', authMiddleware, zValidator('json', createSchema), async (c) => {
  const userId = getUserId(c)
  const { workspace_id, label, is_baseline } = c.req.valid('json')
  if (!(await ownsWorkspace(workspace_id, userId)))
    return c.json({ error: 'Forbidden' }, 403)

  const { posture, pipeline_count, finding_count } = await capturePosture(workspace_id)

  // A workspace has at most one baseline; pinning a new one unpins the rest.
  if (is_baseline) {
    await db
      .update(snapshots)
      .set({ is_baseline: false })
      .where(eq(snapshots.workspace_id, workspace_id))
  }

  const [s] = await db
    .insert(snapshots)
    .values({
      workspace_id,
      label,
      is_baseline: is_baseline ?? false,
      posture,
      pipeline_count,
      finding_count,
      created_by: userId,
    })
    .returning()

  await db.insert(activity_log).values({
    workspace_id,
    actor_id: userId,
    action: 'snapshot.create',
    entity_type: 'snapshot',
    entity_id: s.id,
    metadata: { label, pipeline_count, finding_count, is_baseline: s.is_baseline },
  })

  return c.json(s, 201)
})

// ---------------------------------------------------------------------------
// POST /:id/baseline — pin (or toggle) the approved baseline posture
// ---------------------------------------------------------------------------

router.post('/:id/baseline', authMiddleware, zValidator('json', baselineSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(snapshots).where(eq(snapshots.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId)))
    return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json') ?? {}
  // Default behaviour: pin this snapshot. Explicit `is_baseline:false` unpins.
  const target = body.is_baseline === undefined ? true : body.is_baseline

  if (target) {
    // Unpin every other baseline in the workspace first.
    await db
      .update(snapshots)
      .set({ is_baseline: false })
      .where(eq(snapshots.workspace_id, existing.workspace_id))
  }

  const [updated] = await db
    .update(snapshots)
    .set({ is_baseline: target })
    .where(eq(snapshots.id, id))
    .returning()

  await db.insert(activity_log).values({
    workspace_id: existing.workspace_id,
    actor_id: userId,
    action: target ? 'snapshot.pin_baseline' : 'snapshot.unpin_baseline',
    entity_type: 'snapshot',
    entity_id: id,
    metadata: { label: existing.label },
  })

  return c.json(updated)
})

// ---------------------------------------------------------------------------
// DELETE /:id — delete snapshot
// ---------------------------------------------------------------------------

router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(snapshots).where(eq(snapshots.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId)))
    return c.json({ error: 'Forbidden' }, 403)
  await db.delete(snapshots).where(eq(snapshots.id, id))
  return c.json({ success: true })
})

export default router
