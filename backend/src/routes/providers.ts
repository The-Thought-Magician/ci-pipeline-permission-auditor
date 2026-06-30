import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import { providers, workspaces } from '../db/schema.js'
import { eq, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const PROVIDER_KINDS = ['github_actions', 'gitlab_ci', 'jenkins'] as const

const createSchema = z.object({
  workspace_id: z.string().min(1),
  kind: z.enum(PROVIDER_KINDS),
  name: z.string().min(1),
  base_url: z.string().optional().default(''),
  org: z.string().optional().default(''),
  status: z.string().optional().default('connected'),
})

const updateSchema = z.object({
  kind: z.enum(PROVIDER_KINDS).optional(),
  name: z.string().min(1).optional(),
  base_url: z.string().optional(),
  org: z.string().optional(),
  status: z.string().optional(),
})

/** Verify the caller owns the workspace; returns the workspace or null. */
async function ownedWorkspace(workspaceId: string, userId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  if (!ws) return { ws: null, forbidden: false }
  if (ws.owner_id !== userId) return { ws, forbidden: true }
  return { ws, forbidden: false }
}

// Public: list providers, optionally scoped by workspace_id.
router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const rows = workspaceId
    ? await db.select().from(providers).where(eq(providers.workspace_id, workspaceId)).orderBy(desc(providers.created_at))
    : await db.select().from(providers).orderBy(desc(providers.created_at))
  return c.json(rows)
})

// Public: provider detail.
router.get('/:id', async (c) => {
  const [p] = await db.select().from(providers).where(eq(providers.id, c.req.param('id')))
  if (!p) return c.json({ error: 'Not found' }, 404)
  return c.json(p)
})

// Auth + workspace owner: create provider.
router.post('/', authMiddleware, zValidator('json', createSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')
  const { ws, forbidden } = await ownedWorkspace(body.workspace_id, userId)
  if (!ws) return c.json({ error: 'Workspace not found' }, 404)
  if (forbidden) return c.json({ error: 'Forbidden' }, 403)
  const [p] = await db
    .insert(providers)
    .values({
      workspace_id: body.workspace_id,
      kind: body.kind,
      name: body.name,
      base_url: body.base_url ?? '',
      org: body.org ?? '',
      status: body.status ?? 'connected',
      created_by: userId,
    })
    .returning()
  return c.json(p, 201)
})

// Auth + workspace owner: update provider.
router.put('/:id', authMiddleware, zValidator('json', updateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(providers).where(eq(providers.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const { forbidden } = await ownedWorkspace(existing.workspace_id, userId)
  if (forbidden) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const [updated] = await db.update(providers).set(body).where(eq(providers.id, id)).returning()
  return c.json(updated)
})

// Auth + workspace owner: delete provider.
router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(providers).where(eq(providers.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const { forbidden } = await ownedWorkspace(existing.workspace_id, userId)
  if (forbidden) return c.json({ error: 'Forbidden' }, 403)
  await db.delete(providers).where(eq(providers.id, id))
  return c.json({ success: true })
})

export default router
