import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import { workspaces } from '../db/schema.js'
import { eq, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base.length > 0 ? base : 'workspace'
}

const createSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  description: z.string().optional().default(''),
  severity_thresholds: z.record(z.string(), z.number()).optional().default({}),
  rotation_age_days: z.number().int().positive().optional().default(90),
})

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  severity_thresholds: z.record(z.string(), z.number()).optional(),
  rotation_age_days: z.number().int().positive().optional(),
})

// Public: list workspaces owned by the header user (or all if no header).
router.get('/', async (c) => {
  const userId = getUserId(c)
  const rows = userId
    ? await db.select().from(workspaces).where(eq(workspaces.owner_id, userId)).orderBy(desc(workspaces.created_at))
    : await db.select().from(workspaces).orderBy(desc(workspaces.created_at))
  return c.json(rows)
})

// Public: get one workspace.
router.get('/:id', async (c) => {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, c.req.param('id')))
  if (!ws) return c.json({ error: 'Not found' }, 404)
  return c.json(ws)
})

// Auth: create a workspace (owner_id = header user).
router.post('/', authMiddleware, zValidator('json', createSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')
  let slug = (body.slug && body.slug.length > 0 ? slugify(body.slug) : slugify(body.name))
  // Ensure slug uniqueness deterministically.
  const existing = await db.select().from(workspaces).where(eq(workspaces.slug, slug))
  if (existing.length > 0) slug = `${slug}-${Date.now().toString(36)}`
  const [ws] = await db
    .insert(workspaces)
    .values({
      name: body.name,
      slug,
      owner_id: userId,
      description: body.description ?? '',
      severity_thresholds: body.severity_thresholds ?? {},
      rotation_age_days: body.rotation_age_days ?? 90,
    })
    .returning()
  return c.json(ws, 201)
})

// Auth + owner: update workspace.
router.put('/:id', authMiddleware, zValidator('json', updateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(workspaces).where(eq(workspaces.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.owner_id !== userId) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const [updated] = await db
    .update(workspaces)
    .set({ ...body, updated_at: new Date() })
    .where(eq(workspaces.id, id))
    .returning()
  return c.json(updated)
})

// Auth + owner: delete workspace.
router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(workspaces).where(eq(workspaces.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.owner_id !== userId) return c.json({ error: 'Forbidden' }, 403)
  await db.delete(workspaces).where(eq(workspaces.id, id))
  return c.json({ success: true })
})

export default router
