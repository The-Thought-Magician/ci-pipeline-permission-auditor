import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  workspaces,
  pipelines,
  blast_radius,
  resources,
  secrets,
  secret_references,
  effective_permissions,
  pipeline_actions,
  actions,
  attack_paths,
} from '../db/schema.js'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ownsWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  if (!workspaceId || !userId) return false
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  return !!ws && ws.owner_id === userId
}

/**
 * Deterministic blast-radius computation for a single pipeline. Walks the
 * effective permissions + secret references + third-party actions to derive
 * the set of reachable resources / secrets / pipelines, counts crown jewels,
 * and produces a weighted score.
 *
 * The optional `removeActions` set lets callers run what-if simulations by
 * excluding certain effective-permission actions from the reachability walk.
 */
async function computeForPipeline(
  pipeline: typeof pipelines.$inferSelect,
  removeActions: Set<string> = new Set(),
): Promise<{
  score: number
  reachable_resource_ids: string[]
  reachable_secret_ids: string[]
  reachable_pipeline_ids: string[]
  crown_jewel_count: number
  summary: string
}> {
  const wsId = pipeline.workspace_id

  // Effective permissions for this pipeline (after applying the what-if removal).
  const effs = await db
    .select()
    .from(effective_permissions)
    .where(eq(effective_permissions.pipeline_id, pipeline.id))
  const activeEffs = effs.filter((e) => !removeActions.has(e.action))

  // Reachable resources: distinct resource_ids referenced by active effective perms.
  const reachableResourceIds = new Set<string>()
  for (const e of activeEffs) {
    if (e.resource_id) reachableResourceIds.add(e.resource_id)
  }

  // Reachable secrets: secrets this pipeline references.
  const secRefs = await db
    .select()
    .from(secret_references)
    .where(eq(secret_references.pipeline_id, pipeline.id))
  const reachableSecretIds = new Set<string>(secRefs.map((r) => r.secret_id))

  // Crown-jewel count among reachable resources.
  let crownJewelCount = 0
  if (reachableResourceIds.size > 0) {
    const wsResources = await db
      .select()
      .from(resources)
      .where(eq(resources.workspace_id, wsId))
    for (const r of wsResources) {
      if (reachableResourceIds.has(r.id) && r.is_crown_jewel) crownJewelCount++
    }
  }

  // Reachable pipelines: other pipelines in the workspace that share a reachable
  // resource or a reachable secret (lateral movement surface).
  const reachablePipelineIds = new Set<string>()
  if (reachableResourceIds.size > 0 || reachableSecretIds.size > 0) {
    // Pipelines sharing a reachable resource via their effective perms.
    if (reachableResourceIds.size > 0) {
      const wsEffs = await db
        .select()
        .from(effective_permissions)
        .where(eq(effective_permissions.workspace_id, wsId))
      for (const e of wsEffs) {
        if (e.pipeline_id === pipeline.id) continue
        if (e.resource_id && reachableResourceIds.has(e.resource_id)) {
          reachablePipelineIds.add(e.pipeline_id)
        }
      }
    }
    // Pipelines sharing a reachable secret.
    if (reachableSecretIds.size > 0) {
      const wsSecRefs = await db
        .select()
        .from(secret_references)
        .where(eq(secret_references.workspace_id, wsId))
      for (const r of wsSecRefs) {
        if (r.pipeline_id === pipeline.id) continue
        if (reachableSecretIds.has(r.secret_id)) reachablePipelineIds.add(r.pipeline_id)
      }
    }
  }

  // Risky third-party actions inflate the score (supply-chain reach).
  const pas = await db
    .select()
    .from(pipeline_actions)
    .where(eq(pipeline_actions.pipeline_id, pipeline.id))
  let riskyActionCount = 0
  if (pas.length > 0) {
    const wsActions = await db.select().from(actions).where(eq(actions.workspace_id, wsId))
    const actionMap = new Map(wsActions.map((a) => [a.id, a]))
    for (const pa of pas) {
      const a = actionMap.get(pa.action_id)
      if (a && (a.risk_level === 'high' || a.risk_level === 'critical' || a.pin_type !== 'sha')) {
        riskyActionCount++
      }
    }
  }

  // Weighted score (0..100-ish, clamped). Crown jewels and excess perms dominate.
  const excessCount = activeEffs.filter((e) => e.is_excess).length
  let score =
    reachableResourceIds.size * 3 +
    reachableSecretIds.size * 4 +
    reachablePipelineIds.size * 2 +
    crownJewelCount * 15 +
    excessCount * 5 +
    riskyActionCount * 3
  score = Math.min(100, Math.round(score * 10) / 10)

  const summary =
    `Reaches ${reachableResourceIds.size} resource(s), ${reachableSecretIds.size} secret(s), ` +
    `${reachablePipelineIds.size} pipeline(s); ${crownJewelCount} crown jewel(s), ` +
    `${excessCount} excess permission(s), ${riskyActionCount} risky action(s).`

  return {
    score,
    reachable_resource_ids: [...reachableResourceIds],
    reachable_secret_ids: [...reachableSecretIds],
    reachable_pipeline_ids: [...reachablePipelineIds],
    crown_jewel_count: crownJewelCount,
    summary,
  }
}

// ---------------------------------------------------------------------------
// GET / — list blast-radius results for a workspace
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  if (!workspaceId) return c.json({ error: 'workspace_id is required' }, 400)
  const rows = await db
    .select()
    .from(blast_radius)
    .where(eq(blast_radius.workspace_id, workspaceId))
    .orderBy(desc(blast_radius.score))
  return c.json(rows)
})

// ---------------------------------------------------------------------------
// GET /:pipelineId — blast radius for a single pipeline (latest)
// ---------------------------------------------------------------------------

router.get('/:pipelineId', async (c) => {
  const pipelineId = c.req.param('pipelineId')
  const [row] = await db
    .select()
    .from(blast_radius)
    .where(eq(blast_radius.pipeline_id, pipelineId))
    .orderBy(desc(blast_radius.computed_at))
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json(row)
})

// ---------------------------------------------------------------------------
// POST /compute — (re)compute blast radius for a workspace or single pipeline
// ---------------------------------------------------------------------------

const computeSchema = z.object({
  workspace_id: z.string().min(1),
  pipeline_id: z.string().optional(),
})

router.post('/compute', authMiddleware, zValidator('json', computeSchema), async (c) => {
  const userId = getUserId(c)
  const { workspace_id, pipeline_id } = c.req.valid('json')
  if (!(await ownsWorkspace(workspace_id, userId))) return c.json({ error: 'Forbidden' }, 403)

  let targets: (typeof pipelines.$inferSelect)[]
  if (pipeline_id) {
    const [p] = await db.select().from(pipelines).where(eq(pipelines.id, pipeline_id))
    if (!p) return c.json({ error: 'Pipeline not found' }, 404)
    if (p.workspace_id !== workspace_id) return c.json({ error: 'Forbidden' }, 403)
    targets = [p]
  } else {
    targets = await db.select().from(pipelines).where(eq(pipelines.workspace_id, workspace_id))
  }

  let computed = 0
  for (const p of targets) {
    const result = await computeForPipeline(p)
    // Replace any prior blast-radius rows for this pipeline.
    await db.delete(blast_radius).where(eq(blast_radius.pipeline_id, p.id))
    await db.insert(blast_radius).values({
      workspace_id,
      pipeline_id: p.id,
      score: result.score,
      reachable_resource_ids: result.reachable_resource_ids,
      reachable_secret_ids: result.reachable_secret_ids,
      reachable_pipeline_ids: result.reachable_pipeline_ids,
      crown_jewel_count: result.crown_jewel_count,
      summary: result.summary,
    })
    // Keep the pipeline's risk_score loosely in sync with its blast radius.
    await db.update(pipelines).set({ risk_score: result.score }).where(eq(pipelines.id, p.id))
    computed++
  }

  return c.json({ computed })
})

// ---------------------------------------------------------------------------
// POST /simulate — what-if re-score after removing proposed permissions
// ---------------------------------------------------------------------------

const simulateSchema = z.object({
  pipeline_id: z.string().min(1),
  remove: z.array(z.string()).default([]),
})

router.post('/simulate', authMiddleware, zValidator('json', simulateSchema), async (c) => {
  const userId = getUserId(c)
  const { pipeline_id, remove } = c.req.valid('json')

  const [p] = await db.select().from(pipelines).where(eq(pipelines.id, pipeline_id))
  if (!p) return c.json({ error: 'Pipeline not found' }, 404)
  if (!(await ownsWorkspace(p.workspace_id, userId))) return c.json({ error: 'Forbidden' }, 403)

  const beforeResult = await computeForPipeline(p)
  const afterResult = await computeForPipeline(p, new Set(remove))

  const before = beforeResult.score
  const after = afterResult.score
  return c.json({
    before,
    after,
    delta: Math.round((after - before) * 10) / 10,
    before_detail: beforeResult,
    after_detail: afterResult,
  })
})

export default router
