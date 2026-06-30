import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import { activity_log, workspaces } from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// ---------------------------------------------------------------------------
// GET / — public read of the immutable activity log.
// Filters: ?workspace_id= (recommended), ?actor_id=, ?entity_type=.
// ---------------------------------------------------------------------------
router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const actorId = c.req.query('actor_id')
  const entityType = c.req.query('entity_type')

  const conditions = []
  if (workspaceId) conditions.push(eq(activity_log.workspace_id, workspaceId))
  if (actorId) conditions.push(eq(activity_log.actor_id, actorId))
  if (entityType) conditions.push(eq(activity_log.entity_type, entityType))

  const base = db.select().from(activity_log)
  const rows = conditions.length
    ? await base.where(and(...conditions)).orderBy(desc(activity_log.created_at))
    : await base.orderBy(desc(activity_log.created_at))

  return c.json(rows)
})

// ---------------------------------------------------------------------------
// POST / — append an activity entry. The log is append-only: there is no
// update or delete. The actor is forced to the authenticated header user.
// ---------------------------------------------------------------------------
const appendSchema = z.object({
  workspace_id: z.string().min(1),
  action: z.string().min(1),
  entity_type: z.string().min(1),
  entity_id: z.string().optional().default(''),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
})

router.post('/', authMiddleware, zValidator('json', appendSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')

  // Workspace must exist and be owned by the header user (workspace-scoped write).
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, body.workspace_id))
  if (!ws) return c.json({ error: 'Workspace not found' }, 404)
  if (ws.owner_id !== userId) return c.json({ error: 'Forbidden' }, 403)

  const [entry] = await db
    .insert(activity_log)
    .values({
      workspace_id: body.workspace_id,
      actor_id: userId,
      action: body.action,
      entity_type: body.entity_type,
      entity_id: body.entity_id,
      metadata: body.metadata,
    })
    .returning()

  return c.json(entry, 201)
})

export default router
