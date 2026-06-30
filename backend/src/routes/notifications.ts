import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import { notifications } from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// ---------------------------------------------------------------------------
// GET / — public read of the per-user notification feed.
// Scoped to the header user; optional ?workspace_id= filter.
// ---------------------------------------------------------------------------
router.get('/', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json([])

  const workspaceId = c.req.query('workspace_id')

  const conditions = [eq(notifications.user_id, userId)]
  if (workspaceId) conditions.push(eq(notifications.workspace_id, workspaceId))

  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.created_at))

  return c.json(rows)
})

// ---------------------------------------------------------------------------
// POST /:id/read — mark a single notification read (owner only).
// ---------------------------------------------------------------------------
router.post('/:id/read', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')

  const [existing] = await db.select().from(notifications).where(eq(notifications.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.user_id !== userId) return c.json({ error: 'Forbidden' }, 403)

  const [updated] = await db
    .update(notifications)
    .set({ is_read: true })
    .where(eq(notifications.id, id))
    .returning()

  return c.json(updated)
})

// ---------------------------------------------------------------------------
// POST /read-all — mark every notification for the header user read.
// Optional workspace_id scopes the bulk update to one workspace.
// ---------------------------------------------------------------------------
const readAllSchema = z.object({
  workspace_id: z.string().optional(),
})

router.post('/read-all', authMiddleware, zValidator('json', readAllSchema), async (c) => {
  const userId = getUserId(c)
  const { workspace_id } = c.req.valid('json')

  const conditions = [eq(notifications.user_id, userId), eq(notifications.is_read, false)]
  if (workspace_id) conditions.push(eq(notifications.workspace_id, workspace_id))

  const updated = await db
    .update(notifications)
    .set({ is_read: true })
    .where(and(...conditions))
    .returning()

  return c.json({ updated: updated.length })
})

export default router
