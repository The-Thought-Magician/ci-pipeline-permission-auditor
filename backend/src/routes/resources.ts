import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  resources,
  workspaces,
  permissions,
  pipeline_identities,
  effective_permissions,
  blast_radius,
  pipelines,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ownsWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  if (!workspaceId) return false
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  return !!ws && ws.owner_id === userId
}

const resourceSchema = z.object({
  workspace_id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['cloud', 'secret', 'registry', 'repo']),
  identifier: z.string().optional().default(''),
  is_crown_jewel: z.boolean().optional().default(false),
  environment: z.string().optional().default(''),
  tags: z.array(z.string()).optional().default([]),
})

const resourceUpdateSchema = resourceSchema.partial().omit({ workspace_id: true })

// ---------------------------------------------------------------------------
// GET /crown-jewels — public — crown-jewel resources + reachability report
// (declared BEFORE /:id so the literal path is matched first)
// ---------------------------------------------------------------------------

router.get('/crown-jewels', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  if (!workspaceId) return c.json({ error: 'workspace_id is required' }, 400)

  const crownJewels = await db
    .select()
    .from(resources)
    .where(and(eq(resources.workspace_id, workspaceId), eq(resources.is_crown_jewel, true)))
    .orderBy(desc(resources.created_at))

  // Pull the data needed to compute reachability once.
  const [perms, effs, blasts, idents, pipes] = await Promise.all([
    db.select().from(permissions).where(eq(permissions.workspace_id, workspaceId)),
    db.select().from(effective_permissions).where(eq(effective_permissions.workspace_id, workspaceId)),
    db.select().from(blast_radius).where(eq(blast_radius.workspace_id, workspaceId)),
    db.select().from(pipeline_identities).where(eq(pipeline_identities.workspace_id, workspaceId)),
    db.select().from(pipelines).where(eq(pipelines.workspace_id, workspaceId)),
  ])

  const pipeName = new Map(pipes.map((p) => [p.id, p.name]))
  const identName = new Map(idents.map((i) => [i.id, i.name]))

  const reachability = crownJewels.map((res) => {
    // Identities directly granted a permission targeting this resource.
    const grantingPerms = perms.filter((p) => p.resource_id === res.id)
    const reachingIdentityIds = new Set<string>()
    for (const p of grantingPerms) {
      if (p.identity_id) reachingIdentityIds.add(p.identity_id)
    }

    // Pipelines whose effective permissions resolve onto this resource.
    const reachingPipelineIds = new Set<string>()
    for (const e of effs) {
      if (e.resource_id === res.id) reachingPipelineIds.add(e.pipeline_id)
    }

    // Pipelines whose computed blast radius lists this resource as reachable.
    for (const b of blasts) {
      const ids = (b.reachable_resource_ids ?? []) as string[]
      if (ids.includes(res.id)) reachingPipelineIds.add(b.pipeline_id)
    }

    // Wildcard-allow permissions of the same category implicitly reach the resource.
    const wildcardReach = grantingPerms.some(
      (p) => p.is_wildcard && p.effect === 'allow',
    )

    const reachingPipelines = [...reachingPipelineIds].map((id) => ({
      id,
      name: pipeName.get(id) ?? id,
    }))
    const reachingIdentities = [...reachingIdentityIds].map((id) => ({
      id,
      name: identName.get(id) ?? id,
    }))

    return {
      resource: res,
      reachable_by_pipelines: reachingPipelines,
      reachable_by_identities: reachingIdentities,
      pipeline_count: reachingPipelines.length,
      identity_count: reachingIdentities.length,
      has_wildcard_access: wildcardReach,
      exposed: reachingPipelines.length > 0 || reachingIdentities.length > 0 || wildcardReach,
    }
  })

  return c.json({ resources: crownJewels, reachability })
})

// ---------------------------------------------------------------------------
// GET / — public — list resources (?workspace_id=&kind=)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const kind = c.req.query('kind')

  const filters = []
  if (workspaceId) filters.push(eq(resources.workspace_id, workspaceId))
  if (kind) filters.push(eq(resources.kind, kind))

  const rows = filters.length
    ? await db
        .select()
        .from(resources)
        .where(filters.length === 1 ? filters[0] : and(...filters))
        .orderBy(desc(resources.created_at))
    : await db.select().from(resources).orderBy(desc(resources.created_at))

  return c.json(rows)
})

// ---------------------------------------------------------------------------
// GET /:id — public — resource detail
// ---------------------------------------------------------------------------

router.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [res] = await db.select().from(resources).where(eq(resources.id, id))
  if (!res) return c.json({ error: 'Not found' }, 404)
  return c.json(res)
})

// ---------------------------------------------------------------------------
// POST / — auth — create resource
// ---------------------------------------------------------------------------

router.post('/', authMiddleware, zValidator('json', resourceSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')
  if (!(await ownsWorkspace(body.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const [created] = await db.insert(resources).values(body).returning()
  return c.json(created, 201)
})

// ---------------------------------------------------------------------------
// PUT /:id — auth+owner — update resource (toggle crown_jewel etc.)
// ---------------------------------------------------------------------------

router.put('/:id', authMiddleware, zValidator('json', resourceUpdateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(resources).where(eq(resources.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const body = c.req.valid('json')
  const [updated] = await db.update(resources).set(body).where(eq(resources.id, id)).returning()
  return c.json(updated)
})

// ---------------------------------------------------------------------------
// DELETE /:id — auth+owner — delete resource (detaches permission targets first)
// ---------------------------------------------------------------------------

router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(resources).where(eq(resources.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  // Null out FK references from permissions / effective_permissions to this resource.
  await db
    .update(permissions)
    .set({ resource_id: null })
    .where(eq(permissions.resource_id, id))
  await db
    .update(effective_permissions)
    .set({ resource_id: null })
    .where(eq(effective_permissions.resource_id, id))
  await db.delete(resources).where(eq(resources.id, id))
  return c.json({ success: true })
})

export default router
