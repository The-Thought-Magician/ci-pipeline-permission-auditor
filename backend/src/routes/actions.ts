import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  workspaces,
  actions,
  pipeline_actions,
  pipelines,
} from '../db/schema.js'
import { eq, and, desc, inArray } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Verify the workspace exists and is owned by the request user. */
async function ownWorkspace(workspaceId: string, userId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  if (!ws) return { ok: false as const, status: 404 as const, error: 'Workspace not found' }
  if (ws.owner_id !== userId) return { ok: false as const, status: 403 as const, error: 'Forbidden' }
  return { ok: true as const, workspace: ws }
}

/**
 * Derive a deterministic pin recommendation for an action. Tag/branch pins are
 * mutable and therefore a supply-chain risk; recommend upgrading to a sha pin.
 */
function pinRecommendation(action: { pin_type: string; pin_ref: string; name: string }) {
  if (action.pin_type === 'sha') {
    return { recommended: false, action: 'none', detail: 'Already pinned to an immutable commit sha.' }
  }
  return {
    recommended: true,
    action: 'pin_to_sha',
    detail:
      `Action "${action.name}" is pinned by ${action.pin_type} ("${action.pin_ref || 'unspecified'}"), ` +
      `which is mutable and can be repointed by the publisher. Pin to a full commit sha instead.`,
  }
}

const actionSchema = z.object({
  workspace_id: z.string().min(1),
  name: z.string().min(1),
  publisher: z.string().optional().default(''),
  pin_type: z.enum(['tag', 'branch', 'sha']).optional().default('tag'),
  pin_ref: z.string().optional().default(''),
  is_verified_publisher: z.boolean().optional().default(false),
  inherited_privileges: z.array(z.string()).optional().default([]),
  risk_level: z.enum(['low', 'medium', 'high', 'critical']).optional().default('low'),
  usage_count: z.number().int().min(0).optional().default(0),
  is_deprecated: z.boolean().optional().default(false),
})

const actionUpdateSchema = z
  .object({
    name: z.string().min(1),
    publisher: z.string(),
    pin_type: z.enum(['tag', 'branch', 'sha']),
    pin_ref: z.string(),
    is_verified_publisher: z.boolean(),
    inherited_privileges: z.array(z.string()),
    risk_level: z.enum(['low', 'medium', 'high', 'critical']),
    usage_count: z.number().int().min(0),
    is_deprecated: z.boolean(),
  })
  .partial()

// ---------------------------------------------------------------------------
// GET / — list third-party actions for a workspace
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  if (!workspaceId) return c.json({ error: 'workspace_id is required' }, 400)
  const rows = await db
    .select()
    .from(actions)
    .where(eq(actions.workspace_id, workspaceId))
    .orderBy(desc(actions.usage_count), desc(actions.created_at))
  const withRecs = rows.map((a) => ({ ...a, recommendation: pinRecommendation(a) }))
  return c.json(withRecs)
})

// ---------------------------------------------------------------------------
// GET /:id — action detail + affected pipelines + pin recommendation
// ---------------------------------------------------------------------------

router.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [action] = await db.select().from(actions).where(eq(actions.id, id))
  if (!action) return c.json({ error: 'Not found' }, 404)

  const links = await db
    .select()
    .from(pipeline_actions)
    .where(eq(pipeline_actions.action_id, id))

  const pipelineIds = [...new Set(links.map((l) => l.pipeline_id))]
  const affectedPipelines = pipelineIds.length
    ? await db.select().from(pipelines).where(inArray(pipelines.id, pipelineIds))
    : []

  const pipelineById = new Map(affectedPipelines.map((p) => [p.id, p]))
  const affected = links.map((l) => {
    const p = pipelineById.get(l.pipeline_id)
    return {
      pipeline_id: l.pipeline_id,
      step_name: l.step_name,
      inherited_privileges: l.inherited_privileges,
      pipeline_name: p?.name ?? null,
      repo: p?.repo ?? null,
      branch: p?.branch ?? null,
      risk_score: p?.risk_score ?? null,
    }
  })

  return c.json({
    ...action,
    recommendation: pinRecommendation(action),
    affected_pipeline_count: pipelineIds.length,
    affected_pipelines: affected,
  })
})

// ---------------------------------------------------------------------------
// POST / — create action
// ---------------------------------------------------------------------------

router.post('/', authMiddleware, zValidator('json', actionSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')
  const owned = await ownWorkspace(body.workspace_id, userId)
  if (!owned.ok) return c.json({ error: owned.error }, owned.status)

  const [created] = await db
    .insert(actions)
    .values({
      workspace_id: body.workspace_id,
      name: body.name,
      publisher: body.publisher,
      pin_type: body.pin_type,
      pin_ref: body.pin_ref,
      is_verified_publisher: body.is_verified_publisher,
      inherited_privileges: body.inherited_privileges,
      risk_level: body.risk_level,
      usage_count: body.usage_count,
      is_deprecated: body.is_deprecated,
    })
    .returning()
  return c.json({ ...created, recommendation: pinRecommendation(created) }, 201)
})

// ---------------------------------------------------------------------------
// PUT /:id — update action (e.g. mark pin tag -> sha)
// ---------------------------------------------------------------------------

router.put('/:id', authMiddleware, zValidator('json', actionUpdateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(actions).where(eq(actions.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const owned = await ownWorkspace(existing.workspace_id, userId)
  if (!owned.ok) return c.json({ error: owned.error }, owned.status)

  const body = c.req.valid('json')
  const [updated] = await db
    .update(actions)
    .set(body)
    .where(eq(actions.id, id))
    .returning()
  return c.json({ ...updated, recommendation: pinRecommendation(updated) })
})

// ---------------------------------------------------------------------------
// DELETE /:id — delete action (and its pipeline links)
// ---------------------------------------------------------------------------

router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(actions).where(eq(actions.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const owned = await ownWorkspace(existing.workspace_id, userId)
  if (!owned.ok) return c.json({ error: owned.error }, owned.status)

  await db.delete(pipeline_actions).where(eq(pipeline_actions.action_id, id))
  await db.delete(actions).where(eq(actions.id, id))
  return c.json({ success: true })
})

export default router
