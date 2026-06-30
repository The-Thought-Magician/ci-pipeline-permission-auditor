import { Hono } from 'hono'
import { db } from '../db/index.js'
import {
  pipelines,
  pipeline_identities,
  findings,
  resources,
  blast_radius,
  effective_permissions,
  evidence_packs,
  snapshots,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'

const router = new Hono()

// ---------------------------------------------------------------------------
// GET /overview — workspace posture KPIs
// ---------------------------------------------------------------------------
router.get('/overview', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  if (!workspaceId) return c.json({ error: 'workspace_id is required' }, 400)

  const [
    pipelineRows,
    identityRows,
    findingRows,
    resourceRows,
    blastRows,
    effectiveRows,
    evidenceRows,
  ] = await Promise.all([
    db.select().from(pipelines).where(eq(pipelines.workspace_id, workspaceId)),
    db.select().from(pipeline_identities).where(eq(pipeline_identities.workspace_id, workspaceId)),
    db.select().from(findings).where(eq(findings.workspace_id, workspaceId)),
    db.select().from(resources).where(eq(resources.workspace_id, workspaceId)),
    db.select().from(blast_radius).where(eq(blast_radius.workspace_id, workspaceId)),
    db.select().from(effective_permissions).where(eq(effective_permissions.workspace_id, workspaceId)),
    db.select().from(evidence_packs).where(eq(evidence_packs.workspace_id, workspaceId)),
  ])

  // Finding mix by severity (only open/acknowledged count toward posture).
  const findingsBySeverity = { critical: 0, high: 0, medium: 0, low: 0 }
  const findingsByStatus = { open: 0, acknowledged: 0, remediated: 0, suppressed: 0 }
  for (const f of findingRows) {
    if (f.severity in findingsBySeverity) {
      findingsBySeverity[f.severity as keyof typeof findingsBySeverity]++
    }
    if (f.status in findingsByStatus) {
      findingsByStatus[f.status as keyof typeof findingsByStatus]++
    }
  }
  const openFindings = findingsByStatus.open + findingsByStatus.acknowledged

  // Average risk score across pipelines.
  const riskSum = pipelineRows.reduce((acc, p) => acc + (p.risk_score ?? 0), 0)
  const avgRiskScore = pipelineRows.length > 0 ? riskSum / pipelineRows.length : 0
  const maxRiskScore = pipelineRows.reduce((acc, p) => Math.max(acc, p.risk_score ?? 0), 0)

  // Crown-jewel reachability: crown-jewel resources and how many are reachable
  // from at least one pipeline's blast radius.
  const crownJewels = resourceRows.filter((r) => r.is_crown_jewel)
  const reachableResourceIds = new Set<string>()
  let blastScoreSum = 0
  for (const b of blastRows) {
    blastScoreSum += b.score ?? 0
    for (const rid of (b.reachable_resource_ids ?? [])) reachableResourceIds.add(rid)
  }
  const reachableCrownJewels = crownJewels.filter((r) => reachableResourceIds.has(r.id)).length

  // Excess (over-privileged) effective permissions.
  const excessPermissions = effectiveRows.filter((e) => e.is_excess).length

  // Control coverage from evidence packs (framework/control -> status).
  const coverageTotal = evidenceRows.length
  const coveragePassing = evidenceRows.filter((e) => e.status === 'passing').length
  const coverageFailing = evidenceRows.filter((e) => e.status === 'failing').length

  return c.json({
    workspace_id: workspaceId,
    pipeline_count: pipelineRows.length,
    identity_count: identityRows.length,
    long_lived_identity_count: identityRows.filter((i) => i.is_long_lived).length,
    finding_count: findingRows.length,
    open_finding_count: openFindings,
    findings_by_severity: findingsBySeverity,
    findings_by_status: findingsByStatus,
    avg_risk_score: Number(avgRiskScore.toFixed(2)),
    max_risk_score: Number(maxRiskScore.toFixed(2)),
    resource_count: resourceRows.length,
    crown_jewel_count: crownJewels.length,
    reachable_crown_jewel_count: reachableCrownJewels,
    excess_permission_count: excessPermissions,
    avg_blast_radius: blastRows.length > 0 ? Number((blastScoreSum / blastRows.length).toFixed(2)) : 0,
    control_coverage: {
      total: coverageTotal,
      passing: coveragePassing,
      failing: coverageFailing,
      coverage_pct: coverageTotal > 0 ? Number(((coveragePassing / coverageTotal) * 100).toFixed(1)) : 0,
    },
  })
})

// ---------------------------------------------------------------------------
// GET /risk-trend — risk-score trend across snapshots
// ---------------------------------------------------------------------------
router.get('/risk-trend', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  if (!workspaceId) return c.json({ error: 'workspace_id is required' }, 400)

  const snapshotRows = await db
    .select()
    .from(snapshots)
    .where(eq(snapshots.workspace_id, workspaceId))
    .orderBy(snapshots.created_at)

  const trend = snapshotRows.map((s) => {
    const posture = (s.posture ?? {}) as Record<string, unknown>
    // posture may carry avg_risk_score / finding mix captured at snapshot time.
    const rawScore =
      typeof posture.avg_risk_score === 'number'
        ? (posture.avg_risk_score as number)
        : typeof posture.risk_score === 'number'
          ? (posture.risk_score as number)
          : 0
    return {
      snapshot_id: s.id,
      label: s.label,
      is_baseline: s.is_baseline,
      score: Number(rawScore.toFixed(2)),
      pipeline_count: s.pipeline_count,
      finding_count: s.finding_count,
      created_at: s.created_at,
    }
  })

  return c.json(trend)
})

export default router
