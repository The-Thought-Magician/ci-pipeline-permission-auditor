import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  pipelines,
  workspaces,
  pipeline_identities,
  pipeline_actions,
  actions,
  effective_permissions,
  blast_radius,
  secret_references,
  secrets,
} from '../db/schema.js'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const pipelineSchema = z.object({
  workspace_id: z.string().min(1),
  provider_id: z.string().min(1),
  team_id: z.string().nullable().optional(),
  name: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1).optional().default('main'),
  file_path: z.string().min(1),
  triggers: z.array(z.string()).optional().default([]),
  declared_permissions: z.record(z.string(), z.string()).optional().default({}),
  raw_source: z.string().optional().default(''),
})

const pipelineUpdateSchema = pipelineSchema.partial().omit({ workspace_id: true })

// ---------------------------------------------------------------------------
// Risk scoring (deterministic, derived from declared perms + raw source)
// ---------------------------------------------------------------------------

const WRITE_TOKENS = ['write', 'write-all', 'admin', 'packages:write', 'id-token:write']

function scoreDeclaredPermissions(declared: Record<string, string>): number {
  let score = 0
  for (const [scope, level] of Object.entries(declared)) {
    if (scope === 'write-all' || level === 'write-all') score += 30
    else if (level === 'write' || WRITE_TOKENS.includes(level)) score += 12
    else if (level === 'read' || level === 'read-all') score += 1
  }
  return score
}

function scoreRawSource(raw: string): number {
  if (!raw) return 0
  let score = 0
  const lower = raw.toLowerCase()
  // Unpinned third-party actions referenced by tag/branch instead of sha.
  const uses = raw.match(/uses:\s*\S+@\S+/gi) ?? []
  for (const u of uses) {
    const ref = u.split('@')[1]?.trim() ?? ''
    const isSha = /^[0-9a-f]{40}$/i.test(ref)
    if (!isSha) score += 4
  }
  if (lower.includes('pull_request_target')) score += 15
  if (lower.includes('${{ github.event.issue') || lower.includes('${{ github.event.comment')) score += 8
  if (/permissions:\s*write-all/i.test(raw)) score += 25
  if (lower.includes('self-hosted')) score += 6
  return score
}

async function computeRiskScore(pipelineId: string): Promise<number> {
  const [p] = await db.select().from(pipelines).where(eq(pipelines.id, pipelineId))
  if (!p) return 0
  let score = 0
  score += scoreDeclaredPermissions((p.declared_permissions ?? {}) as Record<string, string>)
  score += scoreRawSource(p.raw_source ?? '')

  // Long-lived / stored credentials raise risk.
  const idents = await db
    .select()
    .from(pipeline_identities)
    .where(eq(pipeline_identities.pipeline_id, pipelineId))
  for (const id of idents) {
    if (id.is_long_lived) score += 10
    if (id.identity_type === 'stored_credential') score += 8
    if (id.identity_type === 'github_token') score += 2
  }

  // Risky third-party actions in use.
  const pas = await db
    .select({ risk_level: actions.risk_level, pin_type: actions.pin_type, verified: actions.is_verified_publisher })
    .from(pipeline_actions)
    .innerJoin(actions, eq(pipeline_actions.action_id, actions.id))
    .where(eq(pipeline_actions.pipeline_id, pipelineId))
  for (const a of pas) {
    if (a.risk_level === 'critical') score += 15
    else if (a.risk_level === 'high') score += 9
    else if (a.risk_level === 'medium') score += 4
    if (a.pin_type !== 'sha') score += 3
    if (!a.verified) score += 2
  }

  // Excess effective permissions.
  const eff = await db
    .select()
    .from(effective_permissions)
    .where(eq(effective_permissions.pipeline_id, pipelineId))
  for (const e of eff) {
    if (e.is_excess) score += 5
  }

  // Secrets exposed to fork PRs / plaintext that this pipeline references.
  const refs = await db
    .select({
      exposed: secrets.exposed_to_fork_pr,
      plaintext: secrets.is_plaintext,
      masked: secrets.is_masked,
    })
    .from(secret_references)
    .innerJoin(secrets, eq(secret_references.secret_id, secrets.id))
    .where(eq(secret_references.pipeline_id, pipelineId))
  for (const r of refs) {
    if (r.exposed) score += 12
    if (r.plaintext) score += 8
    if (!r.masked) score += 4
  }

  return Math.round(Math.min(100, score) * 100) / 100
}

// ---------------------------------------------------------------------------
// Source parsing (best-effort, deterministic, no external deps)
// ---------------------------------------------------------------------------

function parseTriggers(raw: string): string[] {
  if (!raw) return []
  const found = new Set<string>()
  for (const t of [
    'push',
    'pull_request',
    'pull_request_target',
    'workflow_dispatch',
    'schedule',
    'release',
    'issue_comment',
    'workflow_call',
  ]) {
    if (new RegExp(`(^|\\s|\\[|,)${t}(:|\\s|,|\\]|$)`, 'm').test(raw)) found.add(t)
  }
  return [...found]
}

function parseDeclaredPermissions(raw: string): Record<string, string> {
  if (!raw) return {}
  const out: Record<string, string> = {}
  if (/permissions:\s*write-all/i.test(raw)) return { 'write-all': 'write-all' }
  if (/permissions:\s*read-all/i.test(raw)) return { 'read-all': 'read-all' }
  // Match "  contents: write" style entries.
  const re = /^\s*([a-z-]+):\s*(read|write|none)\s*$/gim
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const scope = m[1].toLowerCase()
    if (['name', 'on', 'jobs', 'steps', 'uses', 'with', 'env', 'run'].includes(scope)) continue
    out[scope] = m[2].toLowerCase()
  }
  return out
}

// ---------------------------------------------------------------------------
// Ownership helper
// ---------------------------------------------------------------------------

async function ownsWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  return !!ws && ws.owner_id === userId
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET / — list pipelines, filterable by workspace_id / provider_id / team_id
router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const providerId = c.req.query('provider_id')
  const teamId = c.req.query('team_id')
  const filters = []
  if (workspaceId) filters.push(eq(pipelines.workspace_id, workspaceId))
  if (providerId) filters.push(eq(pipelines.provider_id, providerId))
  if (teamId) filters.push(eq(pipelines.team_id, teamId))
  const rows = await db
    .select()
    .from(pipelines)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(pipelines.risk_score), desc(pipelines.created_at))
  return c.json(rows)
})

// GET /:id — deep detail join
router.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [pipeline] = await db.select().from(pipelines).where(eq(pipelines.id, id))
  if (!pipeline) return c.json({ error: 'Not found' }, 404)

  const identities = await db
    .select()
    .from(pipeline_identities)
    .where(eq(pipeline_identities.pipeline_id, id))
    .orderBy(desc(pipeline_identities.created_at))

  const usedActions = await db
    .select({
      link: pipeline_actions,
      action: actions,
    })
    .from(pipeline_actions)
    .innerJoin(actions, eq(pipeline_actions.action_id, actions.id))
    .where(eq(pipeline_actions.pipeline_id, id))

  const effective = await db
    .select()
    .from(effective_permissions)
    .where(eq(effective_permissions.pipeline_id, id))
    .orderBy(desc(effective_permissions.resolved_at))

  const [radius] = await db
    .select()
    .from(blast_radius)
    .where(eq(blast_radius.pipeline_id, id))
    .orderBy(desc(blast_radius.computed_at))
    .limit(1)

  const referencedSecrets = await db
    .select({
      reference: secret_references,
      secret: secrets,
    })
    .from(secret_references)
    .innerJoin(secrets, eq(secret_references.secret_id, secrets.id))
    .where(eq(secret_references.pipeline_id, id))

  return c.json({
    ...pipeline,
    identities,
    actions: usedActions.map((a) => ({ ...a.action, step_name: a.link.step_name, inherited_privileges: a.link.inherited_privileges })),
    effective_permissions: effective,
    blast_radius: radius ?? null,
    secrets: referencedSecrets.map((s) => ({ ...s.secret, usage_context: s.reference.usage_context, is_logged: s.reference.is_logged })),
  })
})

// POST / — create pipeline (parses raw_source if provided)
router.post('/', authMiddleware, zValidator('json', pipelineSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')
  if (!(await ownsWorkspace(body.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const raw = body.raw_source ?? ''
  const triggers = body.triggers && body.triggers.length ? body.triggers : parseTriggers(raw)
  const declared =
    body.declared_permissions && Object.keys(body.declared_permissions).length
      ? body.declared_permissions
      : parseDeclaredPermissions(raw)

  const [created] = await db
    .insert(pipelines)
    .values({
      workspace_id: body.workspace_id,
      provider_id: body.provider_id,
      team_id: body.team_id ?? null,
      name: body.name,
      repo: body.repo,
      branch: body.branch ?? 'main',
      file_path: body.file_path,
      triggers,
      declared_permissions: declared,
      raw_source: raw,
      last_seen_at: new Date(),
    })
    .returning()

  const risk = await computeRiskScore(created.id)
  const [withRisk] = await db
    .update(pipelines)
    .set({ risk_score: risk })
    .where(eq(pipelines.id, created.id))
    .returning()

  return c.json(withRisk, 201)
})

// PUT /:id — update pipeline
router.put('/:id', authMiddleware, zValidator('json', pipelineUpdateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(pipelines).where(eq(pipelines.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const body = c.req.valid('json')
  const patch: Record<string, unknown> = {}
  for (const key of ['provider_id', 'name', 'repo', 'branch', 'file_path', 'triggers', 'declared_permissions', 'raw_source'] as const) {
    if (body[key] !== undefined) patch[key] = body[key]
  }
  if (body.team_id !== undefined) patch.team_id = body.team_id ?? null

  // If raw_source changed and triggers/permissions not explicitly supplied, re-parse.
  if (body.raw_source !== undefined && body.triggers === undefined) {
    patch.triggers = parseTriggers(body.raw_source ?? '')
  }
  if (body.raw_source !== undefined && body.declared_permissions === undefined) {
    patch.declared_permissions = parseDeclaredPermissions(body.raw_source ?? '')
  }

  await db.update(pipelines).set(patch).where(eq(pipelines.id, id))
  const risk = await computeRiskScore(id)
  const [updated] = await db.update(pipelines).set({ risk_score: risk }).where(eq(pipelines.id, id)).returning()
  return c.json(updated)
})

// POST /:id/analyze — recompute risk_score
router.post('/:id/analyze', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(pipelines).where(eq(pipelines.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const risk = await computeRiskScore(id)
  const [updated] = await db
    .update(pipelines)
    .set({ risk_score: risk, last_seen_at: new Date() })
    .where(eq(pipelines.id, id))
    .returning()
  return c.json(updated)
})

// DELETE /:id
router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(pipelines).where(eq(pipelines.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await db.delete(pipelines).where(eq(pipelines.id, id))
  return c.json({ success: true })
})

export default router
