import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  workspaces,
  reports,
  pipelines,
  findings,
  secrets,
  blast_radius,
  pipeline_identities,
  effective_permissions,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const REPORT_KINDS = ['exec_summary', 'pipeline_deep_dive', 'blast_radius', 'secret_hygiene'] as const

const generateSchema = z.object({
  workspace_id: z.string().min(1),
  kind: z.enum(REPORT_KINDS),
  pipeline_id: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  format: z.enum(['markdown', 'json', 'html']).optional().default('markdown'),
})

// ---------------------------------------------------------------------------
// Ownership helper — a workspace's owner_id must match the header user.
// ---------------------------------------------------------------------------
async function ownsWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  return !!ws && ws.owner_id === userId
}

// ---------------------------------------------------------------------------
// Report content builders — real aggregation over the workspace's data.
// ---------------------------------------------------------------------------
function severityMix(rows: { severity: string }[]): Record<string, number> {
  const mix: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const r of rows) mix[r.severity] = (mix[r.severity] ?? 0) + 1
  return mix
}

async function buildExecSummary(workspaceId: string) {
  const pipes = await db.select().from(pipelines).where(eq(pipelines.workspace_id, workspaceId))
  const finds = await db.select().from(findings).where(eq(findings.workspace_id, workspaceId))
  const secs = await db.select().from(secrets).where(eq(secrets.workspace_id, workspaceId))
  const radii = await db.select().from(blast_radius).where(eq(blast_radius.workspace_id, workspaceId))

  const openFindings = finds.filter((f) => f.status === 'open')
  const avgRisk = pipes.length
    ? pipes.reduce((s, p) => s + (p.risk_score ?? 0), 0) / pipes.length
    : 0
  const topRisk = [...pipes]
    .sort((a, b) => (b.risk_score ?? 0) - (a.risk_score ?? 0))
    .slice(0, 5)
    .map((p) => ({ id: p.id, name: p.name, repo: p.repo, risk_score: p.risk_score ?? 0 }))
  const maxBlast = radii.reduce((m, r) => Math.max(m, r.score ?? 0), 0)
  const plaintextSecrets = secs.filter((s) => s.is_plaintext).length
  const forkExposed = secs.filter((s) => s.exposed_to_fork_pr).length

  return {
    pipeline_count: pipes.length,
    finding_count: finds.length,
    open_finding_count: openFindings.length,
    finding_severity_mix: severityMix(finds),
    open_finding_severity_mix: severityMix(openFindings),
    avg_risk_score: Math.round(avgRisk * 100) / 100,
    max_blast_radius: maxBlast,
    secret_count: secs.length,
    plaintext_secret_count: plaintextSecrets,
    fork_exposed_secret_count: forkExposed,
    top_risk_pipelines: topRisk,
  }
}

async function buildPipelineDeepDive(workspaceId: string, pipelineId: string) {
  const [pipe] = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.workspace_id, workspaceId), eq(pipelines.id, pipelineId)))
  if (!pipe) return null

  const identities = await db
    .select()
    .from(pipeline_identities)
    .where(eq(pipeline_identities.pipeline_id, pipelineId))
  const effective = await db
    .select()
    .from(effective_permissions)
    .where(eq(effective_permissions.pipeline_id, pipelineId))
  const finds = await db.select().from(findings).where(eq(findings.pipeline_id, pipelineId))
  const [radius] = await db
    .select()
    .from(blast_radius)
    .where(eq(blast_radius.pipeline_id, pipelineId))
    .orderBy(desc(blast_radius.computed_at))

  const excessPerms = effective.filter((e) => e.is_excess)

  return {
    pipeline: {
      id: pipe.id,
      name: pipe.name,
      repo: pipe.repo,
      branch: pipe.branch,
      file_path: pipe.file_path,
      risk_score: pipe.risk_score ?? 0,
      declared_permissions: pipe.declared_permissions ?? {},
      triggers: pipe.triggers ?? [],
    },
    identities: identities.map((i) => ({
      id: i.id,
      name: i.name,
      identity_type: i.identity_type,
      is_long_lived: i.is_long_lived,
      environment: i.environment,
    })),
    effective_permission_count: effective.length,
    excess_permission_count: excessPerms.length,
    excess_permissions: excessPerms.map((e) => ({
      action: e.action,
      category: e.category,
      source_chain: e.source_chain ?? [],
    })),
    finding_count: finds.length,
    finding_severity_mix: severityMix(finds),
    blast_radius: radius
      ? {
          score: radius.score,
          crown_jewel_count: radius.crown_jewel_count,
          reachable_resource_count: (radius.reachable_resource_ids ?? []).length,
          reachable_secret_count: (radius.reachable_secret_ids ?? []).length,
          reachable_pipeline_count: (radius.reachable_pipeline_ids ?? []).length,
          summary: radius.summary,
        }
      : null,
  }
}

async function buildBlastRadius(workspaceId: string) {
  const radii = await db
    .select()
    .from(blast_radius)
    .where(eq(blast_radius.workspace_id, workspaceId))
    .orderBy(desc(blast_radius.score))
  const pipes = await db.select().from(pipelines).where(eq(pipelines.workspace_id, workspaceId))
  const pipeName = new Map(pipes.map((p) => [p.id, p.name]))

  return {
    entry_count: radii.length,
    total_crown_jewels_reachable: radii.reduce((s, r) => s + (r.crown_jewel_count ?? 0), 0),
    ranked: radii.map((r) => ({
      pipeline_id: r.pipeline_id,
      pipeline_name: pipeName.get(r.pipeline_id) ?? r.pipeline_id,
      score: r.score,
      crown_jewel_count: r.crown_jewel_count,
      reachable_resource_count: (r.reachable_resource_ids ?? []).length,
      reachable_secret_count: (r.reachable_secret_ids ?? []).length,
      reachable_pipeline_count: (r.reachable_pipeline_ids ?? []).length,
      summary: r.summary,
    })),
  }
}

async function buildSecretHygiene(workspaceId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  const rotationLimit = ws?.rotation_age_days ?? 90
  const secs = await db.select().from(secrets).where(eq(secrets.workspace_id, workspaceId))

  const overdue = secs.filter((s) => (s.rotation_age_days ?? 0) > rotationLimit)
  const plaintext = secs.filter((s) => s.is_plaintext)
  const unmasked = secs.filter((s) => !s.is_masked)
  const unscoped = secs.filter((s) => !s.is_scoped)
  const forkExposed = secs.filter((s) => s.exposed_to_fork_pr)

  return {
    secret_count: secs.length,
    rotation_age_limit_days: rotationLimit,
    overdue_rotation_count: overdue.length,
    plaintext_count: plaintext.length,
    unmasked_count: unmasked.length,
    unscoped_count: unscoped.length,
    fork_exposed_count: forkExposed.length,
    overdue_secrets: overdue.map((s) => ({
      id: s.id,
      name: s.name,
      store: s.store,
      rotation_age_days: s.rotation_age_days ?? 0,
    })),
    risky_secrets: secs
      .filter((s) => s.is_plaintext || !s.is_masked || s.exposed_to_fork_pr)
      .map((s) => ({
        id: s.id,
        name: s.name,
        store: s.store,
        is_plaintext: s.is_plaintext,
        is_masked: s.is_masked,
        is_scoped: s.is_scoped,
        exposed_to_fork_pr: s.exposed_to_fork_pr,
      })),
  }
}

const KIND_TITLES: Record<(typeof REPORT_KINDS)[number], string> = {
  exec_summary: 'Executive Summary',
  pipeline_deep_dive: 'Pipeline Deep-Dive',
  blast_radius: 'Blast-Radius Report',
  secret_hygiene: 'Secret-Hygiene Report',
}

// ---------------------------------------------------------------------------
// GET / — list reports (public). Filter by workspace_id / kind.
// ---------------------------------------------------------------------------
router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const kind = c.req.query('kind')
  const conds = []
  if (workspaceId) conds.push(eq(reports.workspace_id, workspaceId))
  if (kind) conds.push(eq(reports.kind, kind))
  const rows = await db
    .select()
    .from(reports)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(reports.created_at))
  return c.json(rows)
})

// ---------------------------------------------------------------------------
// GET /:id — report detail (public).
// ---------------------------------------------------------------------------
router.get('/:id', async (c) => {
  const [report] = await db.select().from(reports).where(eq(reports.id, c.req.param('id')))
  if (!report) return c.json({ error: 'Not found' }, 404)
  return c.json(report)
})

// ---------------------------------------------------------------------------
// POST / — generate a report (auth + workspace owner).
// ---------------------------------------------------------------------------
router.post('/', authMiddleware, zValidator('json', generateSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')

  if (!(await ownsWorkspace(body.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  let content: Record<string, unknown>
  let pipelineId: string | null = null

  if (body.kind === 'exec_summary') {
    content = await buildExecSummary(body.workspace_id)
  } else if (body.kind === 'pipeline_deep_dive') {
    if (!body.pipeline_id) {
      return c.json({ error: 'pipeline_id is required for pipeline_deep_dive' }, 400)
    }
    const dd = await buildPipelineDeepDive(body.workspace_id, body.pipeline_id)
    if (!dd) return c.json({ error: 'Pipeline not found in workspace' }, 404)
    content = dd
    pipelineId = body.pipeline_id
  } else if (body.kind === 'blast_radius') {
    content = await buildBlastRadius(body.workspace_id)
  } else {
    content = await buildSecretHygiene(body.workspace_id)
  }

  const title = body.title ?? KIND_TITLES[body.kind]

  const [report] = await db
    .insert(reports)
    .values({
      workspace_id: body.workspace_id,
      kind: body.kind,
      title,
      pipeline_id: pipelineId,
      content: { ...content, generated_at: new Date().toISOString() },
      format: body.format,
      created_by: userId,
    })
    .returning()

  return c.json(report, 201)
})

// ---------------------------------------------------------------------------
// DELETE /:id — delete a report (auth + workspace owner).
// ---------------------------------------------------------------------------
router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(reports).where(eq(reports.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await db.delete(reports).where(eq(reports.id, id))
  return c.json({ success: true })
})

export default router
