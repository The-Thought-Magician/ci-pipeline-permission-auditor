import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import { permissions, workspaces, roles, pipeline_identities, resources } from '../db/schema.js'
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

/** A permission is a wildcard if its action contains a `*` glob. */
function isWildcardAction(action: string): boolean {
  return action.includes('*')
}

const permissionSchema = z.object({
  workspace_id: z.string().min(1),
  role_id: z.string().nullish(),
  identity_id: z.string().nullish(),
  resource_id: z.string().nullish(),
  action: z.string().min(1), // e.g. s3:GetObject, contents:write, *
  effect: z.enum(['allow', 'deny']).optional().default('allow'),
  category: z.enum(['cloud', 'secret', 'registry', 'repo', 'deploy']).optional().default('cloud'),
  is_declared: z.boolean().optional().default(false),
  is_wildcard: z.boolean().optional(),
})

const permissionUpdateSchema = permissionSchema.partial().omit({ workspace_id: true })

// ---------------------------------------------------------------------------
// GET / — public — list permissions (?workspace_id=&role_id=&identity_id=&resource_id=&category=&effect=)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const roleId = c.req.query('role_id')
  const identityId = c.req.query('identity_id')
  const resourceId = c.req.query('resource_id')
  const category = c.req.query('category')
  const effect = c.req.query('effect')

  const filters = []
  if (workspaceId) filters.push(eq(permissions.workspace_id, workspaceId))
  if (roleId) filters.push(eq(permissions.role_id, roleId))
  if (identityId) filters.push(eq(permissions.identity_id, identityId))
  if (resourceId) filters.push(eq(permissions.resource_id, resourceId))
  if (category) filters.push(eq(permissions.category, category))
  if (effect) filters.push(eq(permissions.effect, effect))

  const rows = filters.length
    ? await db
        .select()
        .from(permissions)
        .where(filters.length === 1 ? filters[0] : and(...filters))
        .orderBy(desc(permissions.created_at))
    : await db.select().from(permissions).orderBy(desc(permissions.created_at))

  return c.json(rows)
})

// ---------------------------------------------------------------------------
// POST / — auth — create permission
// ---------------------------------------------------------------------------

router.post('/', authMiddleware, zValidator('json', permissionSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')
  if (!(await ownsWorkspace(body.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  // A permission must attach to at least one principal/target.
  if (!body.role_id && !body.identity_id && !body.resource_id) {
    return c.json({ error: 'Permission must reference a role, identity, or resource' }, 400)
  }

  // Validate referenced rows belong to the same workspace.
  if (body.role_id) {
    const [r] = await db.select().from(roles).where(eq(roles.id, body.role_id))
    if (!r || r.workspace_id !== body.workspace_id) {
      return c.json({ error: 'role_id not found in workspace' }, 400)
    }
  }
  if (body.identity_id) {
    const [iden] = await db
      .select()
      .from(pipeline_identities)
      .where(eq(pipeline_identities.id, body.identity_id))
    if (!iden || iden.workspace_id !== body.workspace_id) {
      return c.json({ error: 'identity_id not found in workspace' }, 400)
    }
  }
  if (body.resource_id) {
    const [res] = await db.select().from(resources).where(eq(resources.id, body.resource_id))
    if (!res || res.workspace_id !== body.workspace_id) {
      return c.json({ error: 'resource_id not found in workspace' }, 400)
    }
  }

  const values = {
    workspace_id: body.workspace_id,
    role_id: body.role_id ?? null,
    identity_id: body.identity_id ?? null,
    resource_id: body.resource_id ?? null,
    action: body.action,
    effect: body.effect,
    category: body.category,
    is_declared: body.is_declared,
    is_wildcard: body.is_wildcard ?? isWildcardAction(body.action),
  }

  const [created] = await db.insert(permissions).values(values).returning()
  return c.json(created, 201)
})

// ---------------------------------------------------------------------------
// PUT /:id — auth+owner — update permission
// ---------------------------------------------------------------------------

router.put('/:id', authMiddleware, zValidator('json', permissionUpdateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(permissions).where(eq(permissions.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const body = c.req.valid('json')
  const patch: Record<string, unknown> = {}
  if (body.role_id !== undefined) patch.role_id = body.role_id ?? null
  if (body.identity_id !== undefined) patch.identity_id = body.identity_id ?? null
  if (body.resource_id !== undefined) patch.resource_id = body.resource_id ?? null
  if (body.action !== undefined) {
    patch.action = body.action
    // Recompute wildcard flag from action unless explicitly provided.
    patch.is_wildcard = body.is_wildcard ?? isWildcardAction(body.action)
  } else if (body.is_wildcard !== undefined) {
    patch.is_wildcard = body.is_wildcard
  }
  if (body.effect !== undefined) patch.effect = body.effect
  if (body.category !== undefined) patch.category = body.category
  if (body.is_declared !== undefined) patch.is_declared = body.is_declared

  const [updated] = await db.update(permissions).set(patch).where(eq(permissions.id, id)).returning()
  return c.json(updated)
})

// ---------------------------------------------------------------------------
// DELETE /:id — auth+owner — delete permission
// ---------------------------------------------------------------------------

router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(permissions).where(eq(permissions.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await db.delete(permissions).where(eq(permissions.id, id))
  return c.json({ success: true })
})

export default router
