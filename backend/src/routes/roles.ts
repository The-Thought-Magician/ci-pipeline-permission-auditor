import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import { roles, permissions, workspaces, resources, pipeline_identities } from '../db/schema.js'
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

const roleSchema = z.object({
  workspace_id: z.string().min(1),
  name: z.string().min(1),
  cloud: z.enum(['aws', 'gcp', 'azure', 'other']).optional().default('aws'),
  arn: z.string().optional().default(''),
  policy_summary: z.record(z.string(), z.unknown()).optional().default({}),
  is_privileged: z.boolean().optional().default(false),
})

const roleUpdateSchema = roleSchema.partial().omit({ workspace_id: true })

// ---------------------------------------------------------------------------
// GET / — public — list roles (?workspace_id=)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const rows = workspaceId
    ? await db.select().from(roles).where(eq(roles.workspace_id, workspaceId)).orderBy(desc(roles.created_at))
    : await db.select().from(roles).orderBy(desc(roles.created_at))
  return c.json(rows)
})

// ---------------------------------------------------------------------------
// GET /:id — public — role detail with attached permissions
// ---------------------------------------------------------------------------

router.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [role] = await db.select().from(roles).where(eq(roles.id, id))
  if (!role) return c.json({ error: 'Not found' }, 404)

  const attached = await db
    .select()
    .from(permissions)
    .where(eq(permissions.role_id, id))
    .orderBy(desc(permissions.created_at))

  // Enrich each attached permission with its target resource / identity detail.
  const detailed = await Promise.all(
    attached.map(async (perm) => {
      let resource = null
      let identity = null
      if (perm.resource_id) {
        const [r] = await db.select().from(resources).where(eq(resources.id, perm.resource_id))
        resource = r ?? null
      }
      if (perm.identity_id) {
        const [iden] = await db
          .select()
          .from(pipeline_identities)
          .where(eq(pipeline_identities.id, perm.identity_id))
        identity = iden ?? null
      }
      return { ...perm, resource, identity }
    }),
  )

  const wildcardCount = attached.filter((p) => p.is_wildcard).length
  const denyCount = attached.filter((p) => p.effect === 'deny').length

  return c.json({
    ...role,
    permissions: detailed,
    permission_count: attached.length,
    wildcard_count: wildcardCount,
    deny_count: denyCount,
    // A role is effectively privileged if flagged OR it carries any wildcard allow.
    is_privileged: role.is_privileged || attached.some((p) => p.is_wildcard && p.effect === 'allow'),
  })
})

// ---------------------------------------------------------------------------
// POST / — auth — create role
// ---------------------------------------------------------------------------

router.post('/', authMiddleware, zValidator('json', roleSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')
  if (!(await ownsWorkspace(body.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const [created] = await db.insert(roles).values(body).returning()
  return c.json(created, 201)
})

// ---------------------------------------------------------------------------
// PUT /:id — auth+owner — update role
// ---------------------------------------------------------------------------

router.put('/:id', authMiddleware, zValidator('json', roleUpdateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(roles).where(eq(roles.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const body = c.req.valid('json')
  const [updated] = await db.update(roles).set(body).where(eq(roles.id, id)).returning()
  return c.json(updated)
})

// ---------------------------------------------------------------------------
// DELETE /:id — auth+owner — delete role (detaches its permissions first)
// ---------------------------------------------------------------------------

router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(roles).where(eq(roles.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  // Remove permissions attached to this role to avoid dangling FK references.
  await db.delete(permissions).where(eq(permissions.role_id, id))
  await db.delete(roles).where(eq(roles.id, id))
  return c.json({ success: true })
})

export default router
