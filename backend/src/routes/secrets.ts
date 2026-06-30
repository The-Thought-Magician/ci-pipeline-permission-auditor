import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  workspaces,
  secrets,
  secret_references,
  pipelines,
} from '../db/schema.js'
import { eq, and, desc, inArray } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ownWorkspace(workspaceId: string, userId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  if (!ws) return { ok: false as const, status: 404 as const, error: 'Workspace not found' }
  if (ws.owner_id !== userId) return { ok: false as const, status: 403 as const, error: 'Forbidden' }
  return { ok: true as const, workspace: ws }
}

/** Days elapsed since an ISO/Date instant, floored; 0 if missing. */
function daysSince(d: Date | string | null | undefined): number {
  if (!d) return 0
  const t = typeof d === 'string' ? Date.parse(d) : d.getTime()
  if (Number.isNaN(t)) return 0
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000))
}

/**
 * Hygiene assessment for a secret. Flags the classic CI secret hazards:
 * plaintext storage, missing log masking, fork-PR exposure, lack of scoping,
 * and overdue rotation versus the workspace rotation policy.
 */
function hygiene(
  secret: {
    is_plaintext: boolean
    is_masked: boolean
    exposed_to_fork_pr: boolean
    is_scoped: boolean
    last_rotated_at: Date | string | null
  },
  rotationPolicyDays: number,
) {
  const ageDays = daysSince(secret.last_rotated_at)
  const overdue = secret.last_rotated_at != null && ageDays > rotationPolicyDays
  const neverRotated = secret.last_rotated_at == null
  const issues: string[] = []
  if (secret.is_plaintext) issues.push('Stored in plaintext')
  if (!secret.is_masked) issues.push('Not masked in logs')
  if (secret.exposed_to_fork_pr) issues.push('Exposed to fork pull requests')
  if (!secret.is_scoped) issues.push('Not scoped to a single pipeline/environment')
  if (overdue) issues.push(`Rotation overdue (${ageDays}d > policy ${rotationPolicyDays}d)`)
  if (neverRotated) issues.push('Never rotated')

  let risk: 'low' | 'medium' | 'high' | 'critical' = 'low'
  if (secret.is_plaintext || secret.exposed_to_fork_pr) risk = 'critical'
  else if (overdue || !secret.is_masked) risk = 'high'
  else if (neverRotated || !secret.is_scoped) risk = 'medium'

  return { risk, issues, age_days: ageDays, rotation_overdue: overdue }
}

const secretSchema = z.object({
  workspace_id: z.string().min(1),
  name: z.string().min(1),
  store: z.enum(['provider', 'vault', 'plaintext', 'env']).optional().default('provider'),
  is_scoped: z.boolean().optional().default(false),
  is_masked: z.boolean().optional().default(true),
  is_plaintext: z.boolean().optional().default(false),
  exposed_to_fork_pr: z.boolean().optional().default(false),
})

const secretUpdateSchema = z
  .object({
    name: z.string().min(1),
    store: z.enum(['provider', 'vault', 'plaintext', 'env']),
    is_scoped: z.boolean(),
    is_masked: z.boolean(),
    is_plaintext: z.boolean(),
    exposed_to_fork_pr: z.boolean(),
  })
  .partial()

// ---------------------------------------------------------------------------
// GET / — list secrets for a workspace (with hygiene assessment)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  if (!workspaceId) return c.json({ error: 'workspace_id is required' }, 400)
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  const policyDays = ws?.rotation_age_days ?? 90
  const rows = await db
    .select()
    .from(secrets)
    .where(eq(secrets.workspace_id, workspaceId))
    .orderBy(desc(secrets.created_at))
  return c.json(rows.map((s) => ({ ...s, hygiene: hygiene(s, policyDays) })))
})

// ---------------------------------------------------------------------------
// GET /:id — secret detail + referencing pipelines
// ---------------------------------------------------------------------------

router.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [secret] = await db.select().from(secrets).where(eq(secrets.id, id))
  if (!secret) return c.json({ error: 'Not found' }, 404)

  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, secret.workspace_id))
  const policyDays = ws?.rotation_age_days ?? 90

  const refs = await db
    .select()
    .from(secret_references)
    .where(eq(secret_references.secret_id, id))

  const pipelineIds = [...new Set(refs.map((r) => r.pipeline_id))]
  const refPipelines = pipelineIds.length
    ? await db.select().from(pipelines).where(inArray(pipelines.id, pipelineIds))
    : []
  const pipelineById = new Map(refPipelines.map((p) => [p.id, p]))

  const references = refs.map((r) => {
    const p = pipelineById.get(r.pipeline_id)
    return {
      pipeline_id: r.pipeline_id,
      usage_context: r.usage_context,
      is_logged: r.is_logged,
      pipeline_name: p?.name ?? null,
      repo: p?.repo ?? null,
      branch: p?.branch ?? null,
    }
  })

  return c.json({
    ...secret,
    hygiene: hygiene(secret, policyDays),
    reference_count: pipelineIds.length,
    references,
  })
})

// ---------------------------------------------------------------------------
// POST / — create secret
// ---------------------------------------------------------------------------

router.post('/', authMiddleware, zValidator('json', secretSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')
  const owned = await ownWorkspace(body.workspace_id, userId)
  if (!owned.ok) return c.json({ error: owned.error }, owned.status)

  const [created] = await db
    .insert(secrets)
    .values({
      workspace_id: body.workspace_id,
      name: body.name,
      store: body.store,
      is_scoped: body.is_scoped,
      is_masked: body.is_masked,
      is_plaintext: body.is_plaintext,
      exposed_to_fork_pr: body.exposed_to_fork_pr,
    })
    .returning()
  const policyDays = owned.workspace.rotation_age_days ?? 90
  return c.json({ ...created, hygiene: hygiene(created, policyDays) }, 201)
})

// ---------------------------------------------------------------------------
// PUT /:id — update secret (mark masked/scoped/etc.)
// ---------------------------------------------------------------------------

router.put('/:id', authMiddleware, zValidator('json', secretUpdateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(secrets).where(eq(secrets.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const owned = await ownWorkspace(existing.workspace_id, userId)
  if (!owned.ok) return c.json({ error: owned.error }, owned.status)

  const body = c.req.valid('json')
  const [updated] = await db
    .update(secrets)
    .set(body)
    .where(eq(secrets.id, id))
    .returning()
  const policyDays = owned.workspace.rotation_age_days ?? 90
  return c.json({ ...updated, hygiene: hygiene(updated, policyDays) })
})

// ---------------------------------------------------------------------------
// POST /:id/rotate — record a rotation (resets age, sets last_rotated_at)
// ---------------------------------------------------------------------------

router.post('/:id/rotate', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(secrets).where(eq(secrets.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const owned = await ownWorkspace(existing.workspace_id, userId)
  if (!owned.ok) return c.json({ error: owned.error }, owned.status)

  const [updated] = await db
    .update(secrets)
    .set({ last_rotated_at: new Date(), rotation_age_days: 0 })
    .where(eq(secrets.id, id))
    .returning()
  const policyDays = owned.workspace.rotation_age_days ?? 90
  return c.json({ ...updated, hygiene: hygiene(updated, policyDays) })
})

// ---------------------------------------------------------------------------
// DELETE /:id — delete secret (and its references)
// ---------------------------------------------------------------------------

router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(secrets).where(eq(secrets.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const owned = await ownWorkspace(existing.workspace_id, userId)
  if (!owned.ok) return c.json({ error: owned.error }, owned.status)

  await db.delete(secret_references).where(eq(secret_references.secret_id, id))
  await db.delete(secrets).where(eq(secrets.id, id))
  return c.json({ success: true })
})

export default router
