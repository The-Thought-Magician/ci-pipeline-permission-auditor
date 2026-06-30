import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  audits,
  workspaces,
  pipelines,
  permissions,
  actions,
  secrets,
  policies,
  policy_violations,
  findings,
  snapshots,
  pipeline_identities,
  oidc_trusts,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

async function getWorkspaceIfOwned(workspaceId: string, userId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  if (!ws) return { ws: null, owned: false }
  return { ws, owned: ws.owner_id === userId }
}

// ---------------------------------------------------------------------------
// GET / — list audits (public)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const rows = await db
    .select()
    .from(audits)
    .where(workspaceId ? eq(audits.workspace_id, workspaceId) : undefined)
    .orderBy(desc(audits.created_at))
  return c.json(rows)
})

// ---------------------------------------------------------------------------
// GET /:id — audit detail / summary (public)
// ---------------------------------------------------------------------------

router.get('/:id', async (c) => {
  const [a] = await db.select().from(audits).where(eq(audits.id, c.req.param('id')))
  if (!a) return c.json({ error: 'Not found' }, 404)
  return c.json(a)
})

// ---------------------------------------------------------------------------
// POST / — create audit (auth)
// ---------------------------------------------------------------------------

const createSchema = z.object({
  workspace_id: z.string().min(1),
  name: z.string().min(1),
  schedule: z.enum(['manual', 'daily', 'weekly', 'monthly']).optional().default('manual'),
})

router.post('/', authMiddleware, zValidator('json', createSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')
  const { owned } = await getWorkspaceIfOwned(body.workspace_id, userId)
  if (!owned) return c.json({ error: 'Forbidden' }, 403)

  const [a] = await db
    .insert(audits)
    .values({
      workspace_id: body.workspace_id,
      name: body.name,
      schedule: body.schedule,
      status: 'idle',
      created_by: userId,
    })
    .returning()
  return c.json(a, 201)
})

// ---------------------------------------------------------------------------
// Internal: posture capture (also used to write a snapshot row)
// ---------------------------------------------------------------------------

async function capturePosture(workspaceId: string) {
  const pipes = await db.select().from(pipelines).where(eq(pipelines.workspace_id, workspaceId))
  const perms = await db.select().from(permissions).where(eq(permissions.workspace_id, workspaceId))
  const idents = await db
    .select()
    .from(pipeline_identities)
    .where(eq(pipeline_identities.workspace_id, workspaceId))
  const trusts = await db.select().from(oidc_trusts).where(eq(oidc_trusts.workspace_id, workspaceId))

  const byPipeline: Record<string, Record<string, unknown>> = {}
  for (const p of pipes) {
    byPipeline[p.id] = {
      name: p.name,
      permissions: Object.entries(p.declared_permissions ?? {}).map(([k, v]) => `${k}:${v}`),
      identities: idents.filter((i) => i.pipeline_id === p.id).map((i) => `${i.identity_type}:${i.name}`),
      actions: [],
      trusts: [],
    }
  }
  for (const t of trusts) {
    // Trusts are identity-scoped; attach to any pipeline owning that identity.
    const ident = idents.find((i) => i.id === t.identity_id)
    if (ident && byPipeline[ident.pipeline_id]) {
      ;(byPipeline[ident.pipeline_id].trusts as string[]).push(
        `${t.issuer}|${t.audience}|${t.sub_claim_pattern}`,
      )
    }
  }

  return {
    pipelines: byPipeline,
    pipeline_count: pipes.length,
    permission_count: perms.length,
    identity_count: idents.length,
    captured_at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Internal: policy evaluation
// ---------------------------------------------------------------------------

async function evaluatePolicies(workspaceId: string): Promise<number> {
  const enabledPolicies = await db
    .select()
    .from(policies)
    .where(and(eq(policies.workspace_id, workspaceId), eq(policies.is_enabled, true)))

  const pipes = await db.select().from(pipelines).where(eq(pipelines.workspace_id, workspaceId))
  const allActions = await db.select().from(actions).where(eq(actions.workspace_id, workspaceId))
  const allSecrets = await db.select().from(secrets).where(eq(secrets.workspace_id, workspaceId))
  const allTrusts = await db.select().from(oidc_trusts).where(eq(oidc_trusts.workspace_id, workspaceId))

  let count = 0
  for (const policy of enabledPolicies) {
    const cfg = (policy.config ?? {}) as Record<string, unknown>

    if (policy.rule_type === 'no_write_all') {
      for (const p of pipes) {
        const perms = p.declared_permissions ?? {}
        const offending = Object.entries(perms).filter(
          ([scope, level]) => scope === 'all' || /write|admin/i.test(String(level)),
        )
        if (offending.length > 0) {
          await db.insert(policy_violations).values({
            workspace_id: workspaceId,
            policy_id: policy.id,
            pipeline_id: p.id,
            status: 'open',
            detail: `Pipeline "${p.name}" declares broad write permissions: ${JSON.stringify(perms)}`,
          })
          count++
        }
      }
    } else if (policy.rule_type === 'actions_pinned_sha') {
      for (const a of allActions) {
        if (a.pin_type !== 'sha') {
          await db.insert(policy_violations).values({
            workspace_id: workspaceId,
            policy_id: policy.id,
            pipeline_id: null,
            status: 'open',
            detail: `Action "${a.name}" is pinned by ${a.pin_type} (${a.pin_ref}) instead of a SHA`,
          })
          count++
        }
      }
    } else if (policy.rule_type === 'oidc_branch_scoped') {
      for (const t of allTrusts) {
        if (!t.is_branch_scoped) {
          await db.insert(policy_violations).values({
            workspace_id: workspaceId,
            policy_id: policy.id,
            pipeline_id: null,
            status: 'open',
            detail: `OIDC trust for issuer "${t.issuer}" is not branch-scoped (sub: ${t.sub_claim_pattern})`,
          })
          count++
        }
      }
    } else if (policy.rule_type === 'secret_rotation_max_days') {
      const maxDays = typeof cfg.max_days === 'number' ? cfg.max_days : 90
      for (const s of allSecrets) {
        if ((s.rotation_age_days ?? 0) > maxDays) {
          await db.insert(policy_violations).values({
            workspace_id: workspaceId,
            policy_id: policy.id,
            pipeline_id: null,
            status: 'open',
            detail: `Secret "${s.name}" rotation age ${s.rotation_age_days}d exceeds max ${maxDays}d`,
          })
          count++
        }
      }
    } else if (policy.rule_type === 'no_plaintext_secret') {
      for (const s of allSecrets) {
        if (s.is_plaintext || s.store === 'plaintext') {
          await db.insert(policy_violations).values({
            workspace_id: workspaceId,
            policy_id: policy.id,
            pipeline_id: null,
            status: 'open',
            detail: `Secret "${s.name}" is stored in plaintext`,
          })
          count++
        }
      }
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Internal: finding scan (detectors)
// ---------------------------------------------------------------------------

async function scanFindings(workspaceId: string, userId: string): Promise<number> {
  const pipes = await db.select().from(pipelines).where(eq(pipelines.workspace_id, workspaceId))
  const allActions = await db.select().from(actions).where(eq(actions.workspace_id, workspaceId))
  const allSecrets = await db.select().from(secrets).where(eq(secrets.workspace_id, workspaceId))
  const allTrusts = await db.select().from(oidc_trusts).where(eq(oidc_trusts.workspace_id, workspaceId))

  let created = 0

  // over_privilege: pipelines declaring write/admin scopes.
  for (const p of pipes) {
    const perms = p.declared_permissions ?? {}
    const broad = Object.entries(perms).filter(([, level]) =>
      /write|admin/i.test(String(level)),
    )
    if (broad.length > 0) {
      await db.insert(findings).values({
        workspace_id: workspaceId,
        pipeline_id: p.id,
        detector: 'over_privilege',
        title: `Over-privileged pipeline: ${p.name}`,
        description: `Pipeline declares broad permissions: ${broad.map(([k, v]) => `${k}:${v}`).join(', ')}`,
        severity: broad.length >= 3 ? 'high' : 'medium',
        status: 'open',
        evidence: { declared_permissions: perms },
        created_by: userId,
      })
      created++
    }
  }

  // action_risk: unverified publisher, tag/branch pin, deprecated.
  for (const a of allActions) {
    const reasons: string[] = []
    if (a.pin_type !== 'sha') reasons.push(`pinned by ${a.pin_type}`)
    if (!a.is_verified_publisher) reasons.push('unverified publisher')
    if (a.is_deprecated) reasons.push('deprecated')
    if (reasons.length > 0) {
      await db.insert(findings).values({
        workspace_id: workspaceId,
        pipeline_id: null,
        detector: 'action_risk',
        title: `Risky action: ${a.name}`,
        description: `${a.name} — ${reasons.join(', ')}`,
        severity: a.pin_type === 'branch' || a.is_deprecated ? 'high' : 'medium',
        status: 'open',
        evidence: { pin_type: a.pin_type, pin_ref: a.pin_ref, verified: a.is_verified_publisher },
        created_by: userId,
      })
      created++
    }
  }

  // secret: plaintext, unmasked, fork-PR exposure, overdue rotation.
  for (const s of allSecrets) {
    const reasons: string[] = []
    if (s.is_plaintext || s.store === 'plaintext') reasons.push('plaintext storage')
    if (!s.is_masked) reasons.push('not masked')
    if (s.exposed_to_fork_pr) reasons.push('exposed to fork PRs')
    if ((s.rotation_age_days ?? 0) > 90) reasons.push(`stale (${s.rotation_age_days}d)`)
    if (reasons.length > 0) {
      await db.insert(findings).values({
        workspace_id: workspaceId,
        pipeline_id: null,
        detector: 'secret',
        title: `Secret hygiene issue: ${s.name}`,
        description: `${s.name} — ${reasons.join(', ')}`,
        severity:
          s.is_plaintext || s.exposed_to_fork_pr ? 'critical' : reasons.length >= 2 ? 'high' : 'medium',
        status: 'open',
        evidence: {
          plaintext: s.is_plaintext,
          masked: s.is_masked,
          fork_pr: s.exposed_to_fork_pr,
          rotation_age_days: s.rotation_age_days,
        },
        created_by: userId,
      })
      created++
    }
  }

  // policy: OIDC trusts not branch-scoped.
  for (const t of allTrusts) {
    if (!t.is_branch_scoped) {
      await db.insert(findings).values({
        workspace_id: workspaceId,
        pipeline_id: null,
        detector: 'policy',
        title: `Unscoped OIDC trust: ${t.issuer}`,
        description: `Trust for ${t.issuer} (aud ${t.audience}) is not branch-scoped; sub pattern "${t.sub_claim_pattern}"`,
        severity: 'high',
        status: 'open',
        evidence: { issuer: t.issuer, audience: t.audience, sub_claim_pattern: t.sub_claim_pattern },
        created_by: userId,
      })
      created++
    }
  }

  return created
}

// ---------------------------------------------------------------------------
// POST /:id/run — run audit (snapshot + policy eval + finding scan)
// ---------------------------------------------------------------------------

router.post('/:id/run', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')

  const [audit] = await db.select().from(audits).where(eq(audits.id, id))
  if (!audit) return c.json({ error: 'Not found' }, 404)
  const { owned } = await getWorkspaceIfOwned(audit.workspace_id, userId)
  if (!owned) return c.json({ error: 'Forbidden' }, 403)

  const workspaceId = audit.workspace_id

  // mark running
  await db.update(audits).set({ status: 'running' }).where(eq(audits.id, id))

  try {
    // 1. Snapshot the current posture.
    const posture = await capturePosture(workspaceId)
    const findingCountBefore = (
      await db.select().from(findings).where(eq(findings.workspace_id, workspaceId))
    ).length
    const [snapshot] = await db
      .insert(snapshots)
      .values({
        workspace_id: workspaceId,
        label: `Audit: ${audit.name} @ ${new Date().toISOString()}`,
        is_baseline: false,
        posture,
        pipeline_count: posture.pipeline_count,
        finding_count: findingCountBefore,
        created_by: userId,
      })
      .returning()

    // 2. Evaluate policies (fresh run for this audit).
    const violations = await evaluatePolicies(workspaceId)

    // 3. Scan detectors for new findings.
    const newFindings = await scanFindings(workspaceId, userId)

    const summary = {
      ran_at: new Date().toISOString(),
      snapshot_id: snapshot.id,
      pipeline_count: posture.pipeline_count,
      identity_count: posture.identity_count,
      policy_violations: violations,
      findings_created: newFindings,
    }

    const [updated] = await db
      .update(audits)
      .set({ status: 'completed', last_run_at: new Date(), summary })
      .where(eq(audits.id, id))
      .returning()

    return c.json(updated)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const [failed] = await db
      .update(audits)
      .set({ status: 'failed', last_run_at: new Date(), summary: { error: msg } })
      .where(eq(audits.id, id))
      .returning()
    return c.json(failed, 500)
  }
})

// ---------------------------------------------------------------------------
// DELETE /:id — delete audit (auth + owner)
// ---------------------------------------------------------------------------

router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(audits).where(eq(audits.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const { owned } = await getWorkspaceIfOwned(existing.workspace_id, userId)
  if (!owned) return c.json({ error: 'Forbidden' }, 403)
  await db.delete(audits).where(eq(audits.id, id))
  return c.json({ success: true })
})

export default router
