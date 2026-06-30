import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import { workspaces, alerts } from '../db/schema.js'
import { eq, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const TRIGGER_TYPES = ['new_critical_finding', 'drift_detected', 'secret_overdue'] as const

const createSchema = z.object({
  workspace_id: z.string().min(1),
  name: z.string().min(1),
  trigger_type: z.enum(TRIGGER_TYPES),
  threshold: z.record(z.string(), z.unknown()).optional().default({}),
  is_enabled: z.boolean().optional().default(true),
})

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  trigger_type: z.enum(TRIGGER_TYPES).optional(),
  threshold: z.record(z.string(), z.unknown()).optional(),
  is_enabled: z.boolean().optional(),
})

async function ownsWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  return !!ws && ws.owner_id === userId
}

// ---------------------------------------------------------------------------
// GET / — list alert rules (public). Filter by workspace_id.
// ---------------------------------------------------------------------------
router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const rows = await db
    .select()
    .from(alerts)
    .where(workspaceId ? eq(alerts.workspace_id, workspaceId) : undefined)
    .orderBy(desc(alerts.created_at))
  return c.json(rows)
})

// ---------------------------------------------------------------------------
// POST / — create an alert rule (auth + workspace owner).
// ---------------------------------------------------------------------------
router.post('/', authMiddleware, zValidator('json', createSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')

  if (!(await ownsWorkspace(body.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const [alert] = await db
    .insert(alerts)
    .values({
      workspace_id: body.workspace_id,
      name: body.name,
      trigger_type: body.trigger_type,
      threshold: body.threshold,
      is_enabled: body.is_enabled,
      created_by: userId,
    })
    .returning()

  return c.json(alert, 201)
})

// ---------------------------------------------------------------------------
// PUT /:id — update / enable / disable an alert (auth + workspace owner).
// ---------------------------------------------------------------------------
router.put('/:id', authMiddleware, zValidator('json', updateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db.select().from(alerts).where(eq(alerts.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const [updated] = await db.update(alerts).set(body).where(eq(alerts.id, id)).returning()
  return c.json(updated)
})

// ---------------------------------------------------------------------------
// DELETE /:id — delete an alert rule (auth + workspace owner).
// ---------------------------------------------------------------------------
router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(alerts).where(eq(alerts.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await db.delete(alerts).where(eq(alerts.id, id))
  return c.json({ success: true })
})

export default router
