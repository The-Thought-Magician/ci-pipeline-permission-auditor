import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '../db/index.js'
import { pipeline_identities, pipelines, workspaces, oidc_trusts } from '../db/schema.js'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const identityTypes = ['github_token', 'oidc_role', 'service_account', 'stored_credential'] as const

const identitySchema = z.object({
  workspace_id: z.string().min(1),
  pipeline_id: z.string().min(1),
  identity_type: z.enum(identityTypes),
  name: z.string().min(1),
  credential_kind: z.string().optional().default(''),
  is_long_lived: z.boolean().optional().default(false),
  environment: z.string().optional().default(''),
  tags: z.array(z.string()).optional().default([]),
})

const identityUpdateSchema = identitySchema.partial().omit({ workspace_id: true, pipeline_id: true })

async function ownsWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  return !!ws && ws.owner_id === userId
}

// GET / — list identities, filterable by workspace_id / pipeline_id
router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const pipelineId = c.req.query('pipeline_id')
  const filters = []
  if (workspaceId) filters.push(eq(pipeline_identities.workspace_id, workspaceId))
  if (pipelineId) filters.push(eq(pipeline_identities.pipeline_id, pipelineId))
  const rows = await db
    .select()
    .from(pipeline_identities)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(pipeline_identities.created_at))
  return c.json(rows)
})

// GET /:id — identity detail (with OIDC trusts attached to it)
router.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [identity] = await db.select().from(pipeline_identities).where(eq(pipeline_identities.id, id))
  if (!identity) return c.json({ error: 'Not found' }, 404)
  const trusts = await db.select().from(oidc_trusts).where(eq(oidc_trusts.identity_id, id))
  return c.json({ ...identity, oidc_trusts: trusts })
})

// POST / — create identity
router.post('/', authMiddleware, zValidator('json', identitySchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')
  if (!(await ownsWorkspace(body.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  // Pipeline must exist and live in the same workspace.
  const [pipeline] = await db.select().from(pipelines).where(eq(pipelines.id, body.pipeline_id))
  if (!pipeline) return c.json({ error: 'Pipeline not found' }, 404)
  if (pipeline.workspace_id !== body.workspace_id) {
    return c.json({ error: 'Pipeline does not belong to workspace' }, 400)
  }

  const [created] = await db
    .insert(pipeline_identities)
    .values({
      workspace_id: body.workspace_id,
      pipeline_id: body.pipeline_id,
      identity_type: body.identity_type,
      name: body.name,
      credential_kind: body.credential_kind ?? '',
      is_long_lived: body.is_long_lived ?? false,
      environment: body.environment ?? '',
      tags: body.tags ?? [],
      last_active_at: new Date(),
    })
    .returning()
  return c.json(created, 201)
})

// PUT /:id — update identity
router.put('/:id', authMiddleware, zValidator('json', identityUpdateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(pipeline_identities).where(eq(pipeline_identities.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const body = c.req.valid('json')
  const patch: Record<string, unknown> = {}
  for (const key of ['identity_type', 'name', 'credential_kind', 'is_long_lived', 'environment', 'tags'] as const) {
    if (body[key] !== undefined) patch[key] = body[key]
  }
  const [updated] = await db
    .update(pipeline_identities)
    .set(patch)
    .where(eq(pipeline_identities.id, id))
    .returning()
  return c.json(updated)
})

// DELETE /:id
router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(pipeline_identities).where(eq(pipeline_identities.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  // Remove dependent OIDC trusts first to satisfy FK.
  await db.delete(oidc_trusts).where(eq(oidc_trusts.identity_id, id))
  await db.delete(pipeline_identities).where(eq(pipeline_identities.id, id))
  return c.json({ success: true })
})

export default router
