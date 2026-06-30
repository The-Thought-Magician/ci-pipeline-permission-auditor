import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import { workspaces, teams, pipelines, findings } from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const createSchema = z.object({
  workspace_id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  owner_email: z.string().email().optional().default(''),
  member_ids: z.array(z.string()).optional().default([]),
})

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  owner_email: z.string().email().optional(),
  member_ids: z.array(z.string()).optional(),
})

async function ownsWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  return !!ws && ws.owner_id === userId
}

function severityMix(rows: { severity: string }[]): Record<string, number> {
  const mix: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const r of rows) mix[r.severity] = (mix[r.severity] ?? 0) + 1
  return mix
}

// ---------------------------------------------------------------------------
// Posture rollup for a team: count its pipelines, average risk, and roll up
// findings across those pipelines.
// ---------------------------------------------------------------------------
async function teamPosture(workspaceId: string, teamId: string) {
  const pipes = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.workspace_id, workspaceId), eq(pipelines.team_id, teamId)))
  const pipelineIds = new Set(pipes.map((p) => p.id))

  const wsFindings = await db
    .select()
    .from(findings)
    .where(eq(findings.workspace_id, workspaceId))
  const teamFindings = wsFindings.filter(
    (f) => f.pipeline_id != null && pipelineIds.has(f.pipeline_id),
  )
  const openFindings = teamFindings.filter((f) => f.status === 'open')

  const avgRisk = pipes.length
    ? pipes.reduce((s, p) => s + (p.risk_score ?? 0), 0) / pipes.length
    : 0
  const maxRisk = pipes.reduce((m, p) => Math.max(m, p.risk_score ?? 0), 0)

  return {
    pipeline_count: pipes.length,
    avg_risk_score: Math.round(avgRisk * 100) / 100,
    max_risk_score: maxRisk,
    finding_count: teamFindings.length,
    open_finding_count: openFindings.length,
    finding_severity_mix: severityMix(teamFindings),
    open_finding_severity_mix: severityMix(openFindings),
  }
}

// ---------------------------------------------------------------------------
// GET / — list teams with per-team posture (public). Filter by workspace_id.
// ---------------------------------------------------------------------------
router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const rows = await db
    .select()
    .from(teams)
    .where(workspaceId ? eq(teams.workspace_id, workspaceId) : undefined)
    .orderBy(desc(teams.created_at))

  const withPosture = await Promise.all(
    rows.map(async (t) => ({
      ...t,
      posture: await teamPosture(t.workspace_id, t.id),
    })),
  )
  return c.json(withPosture)
})

// ---------------------------------------------------------------------------
// GET /:id — team detail with owned pipelines + finding rollup (public).
// ---------------------------------------------------------------------------
router.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [team] = await db.select().from(teams).where(eq(teams.id, id))
  if (!team) return c.json({ error: 'Not found' }, 404)

  const pipes = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.workspace_id, team.workspace_id), eq(pipelines.team_id, id)))
  const pipelineIds = new Set(pipes.map((p) => p.id))

  const wsFindings = await db
    .select()
    .from(findings)
    .where(eq(findings.workspace_id, team.workspace_id))
  const teamFindings = wsFindings.filter(
    (f) => f.pipeline_id != null && pipelineIds.has(f.pipeline_id),
  )

  return c.json({
    ...team,
    posture: await teamPosture(team.workspace_id, id),
    pipelines: pipes.map((p) => ({
      id: p.id,
      name: p.name,
      repo: p.repo,
      branch: p.branch,
      risk_score: p.risk_score ?? 0,
    })),
    findings: teamFindings.map((f) => ({
      id: f.id,
      pipeline_id: f.pipeline_id,
      detector: f.detector,
      title: f.title,
      severity: f.severity,
      status: f.status,
    })),
  })
})

// ---------------------------------------------------------------------------
// POST / — create a team (auth + workspace owner).
// ---------------------------------------------------------------------------
router.post('/', authMiddleware, zValidator('json', createSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')

  if (!(await ownsWorkspace(body.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const [existing] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.workspace_id, body.workspace_id), eq(teams.slug, body.slug)))
  if (existing) return c.json({ error: 'A team with that slug already exists' }, 409)

  const [team] = await db
    .insert(teams)
    .values({
      workspace_id: body.workspace_id,
      name: body.name,
      slug: body.slug,
      owner_email: body.owner_email,
      member_ids: body.member_ids,
      created_by: userId,
    })
    .returning()

  return c.json(team, 201)
})

// ---------------------------------------------------------------------------
// PUT /:id — update team / members (auth + workspace owner).
// ---------------------------------------------------------------------------
router.put('/:id', authMiddleware, zValidator('json', updateSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db.select().from(teams).where(eq(teams.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  if (body.slug && body.slug !== existing.slug) {
    const [clash] = await db
      .select()
      .from(teams)
      .where(and(eq(teams.workspace_id, existing.workspace_id), eq(teams.slug, body.slug)))
    if (clash) return c.json({ error: 'A team with that slug already exists' }, 409)
  }

  const [updated] = await db.update(teams).set(body).where(eq(teams.id, id)).returning()
  return c.json(updated)
})

// ---------------------------------------------------------------------------
// DELETE /:id — delete team (auth + workspace owner). Detaches pipelines first.
// ---------------------------------------------------------------------------
router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(teams).where(eq(teams.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  // Unassign pipelines that point at this team so the FK does not block delete.
  await db.update(pipelines).set({ team_id: null }).where(eq(pipelines.team_id, id))
  await db.delete(teams).where(eq(teams.id, id))
  return c.json({ success: true })
})

export default router
