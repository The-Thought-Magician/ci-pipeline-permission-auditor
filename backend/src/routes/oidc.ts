import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '../db/index.js'
import { oidc_trusts, pipeline_identities, workspaces, roles } from '../db/schema.js'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const trustSchema = z.object({
  workspace_id: z.string().min(1),
  identity_id: z.string().nullable().optional(),
  issuer: z.string().min(1),
  audience: z.string().min(1),
  sub_claim_pattern: z.string().min(1),
  is_branch_scoped: z.boolean().optional().default(false),
  assumable_role_ids: z.array(z.string()).optional().default([]),
})

const trustUpdateSchema = trustSchema.partial().omit({ workspace_id: true })

async function ownsWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  return !!ws && ws.owner_id === userId
}

// GET / — list OIDC trusts, filterable by workspace_id / identity_id
router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const identityId = c.req.query('identity_id')
  const filters = []
  if (workspaceId) filters.push(eq(oidc_trusts.workspace_id, workspaceId))
  if (identityId) filters.push(eq(oidc_trusts.identity_id, identityId))
  const rows = await db
    .select()
    .from(oidc_trusts)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(oidc_trusts.created_at))
  return c.json(rows)
})

// GET /:id — trust detail (with identity + resolved assumable roles)
router.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [trust] = await db.select().from(oidc_trusts).where(eq(oidc_trusts.id, id))
  if (!trust) return c.json({ error: 'Not found' }, 404)

  let identity = null
  if (trust.identity_id) {
    const [ident] = await db
      .select()
      .from(pipeline_identities)
      .where(eq(pipeline_identities.id, trust.identity_id))
    identity = ident ?? null
  }

  const roleIds = (trust.assumable_role_ids ?? []) as string[]
  const assumableRoles = []
  for (const rid of roleIds) {
    const [role] = await db.select().from(roles).where(eq(roles.id, rid))
    if (role) assumableRoles.push(role)
  }

  // Heuristic: a wildcard sub_claim_pattern on a non-branch-scoped trust is risky.
  const wildcardSub = trust.sub_claim_pattern.includes('*') || trust.sub_claim_pattern.includes(':*')
  const isOverlyBroad = wildcardSub && !trust.is_branch_scoped

  return c.json({ ...trust, identity, assumable_roles: assumableRoles, is_overly_broad: isOverlyBroad })
})

// POST / — create OIDC trust
router.post('/', authMiddleware, zValidator('json', trustSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')
  if (!(await ownsWorkspace(body.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  // If an identity is referenced it must exist in the same workspace.
  if (body.identity_id) {
    const [ident] = await db
      .select()
      .from(pipeline_identities)
      .where(eq(pipeline_identities.id, body.identity_id))
    if (!ident) return c.json({ error: 'Identity not found' }, 404)
    if (ident.workspace_id !== body.workspace_id) {
      return c.json({ error: 'Identity does not belong to workspace' }, 400)
    }
  }

  const [created] = await db
    .insert(oidc_trusts)
    .values({
      workspace_id: body.workspace_id,
      identity_id: body.identity_id ?? null,
      issuer: body.issuer,
      audience: body.audience,
      sub_claim_pattern: body.sub_claim_pattern,
      is_branch_scoped: body.is_branch_scoped ?? false,
      assumable_role_ids: body.assumable_role_ids ?? [],
    })
    .returning()
  return c.json(created, 201)
})

// PUT /:id — update trust (e.g. tighten sub_claim_pattern, set branch-scoped)
router.put('/:id', authMiddleware, zValidator('json', trustUpdateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(oidc_trusts).where(eq(oidc_trusts.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const body = c.req.valid('json')
  const patch: Record<string, unknown> = {}
  for (const key of ['issuer', 'audience', 'sub_claim_pattern', 'is_branch_scoped', 'assumable_role_ids'] as const) {
    if (body[key] !== undefined) patch[key] = body[key]
  }
  if (body.identity_id !== undefined) patch.identity_id = body.identity_id ?? null
  const [updated] = await db.update(oidc_trusts).set(patch).where(eq(oidc_trusts.id, id)).returning()
  return c.json(updated)
})

// DELETE /:id
router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(oidc_trusts).where(eq(oidc_trusts.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await db.delete(oidc_trusts).where(eq(oidc_trusts.id, id))
  return c.json({ success: true })
})

export default router
