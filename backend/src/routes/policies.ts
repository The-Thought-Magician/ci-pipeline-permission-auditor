import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  policies,
  policy_violations,
  workspaces,
  pipelines,
  actions,
  pipeline_actions,
  pipeline_identities,
  oidc_trusts,
  secrets,
  activity_log,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

async function ownsWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  return !!ws && ws.owner_id === userId
}

const policySchema = z.object({
  workspace_id: z.string().min(1),
  name: z.string().min(1),
  rule_type: z.enum([
    'no_write_all',
    'actions_pinned_sha',
    'oidc_branch_scoped',
    'secret_rotation_max_days',
    'no_plaintext_secret',
  ]),
  config: z.record(z.unknown()).optional().default({}),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional().default('high'),
  is_enabled: z.boolean().optional().default(true),
})

const evaluateSchema = z.object({
  workspace_id: z.string().min(1),
})

const exemptSchema = z.object({
  exemption_reason: z.string().min(1),
})

// ---------------------------------------------------------------------------
// GET / — list policies (public)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const rows = workspaceId
    ? await db
        .select()
        .from(policies)
        .where(eq(policies.workspace_id, workspaceId))
        .orderBy(desc(policies.created_at))
    : await db.select().from(policies).orderBy(desc(policies.created_at))
  return c.json(rows)
})

// ---------------------------------------------------------------------------
// GET /:id/violations — violations for a policy (public)
// ---------------------------------------------------------------------------

router.get('/:id/violations', async (c) => {
  const id = c.req.param('id')
  const rows = await db
    .select()
    .from(policy_violations)
    .where(eq(policy_violations.policy_id, id))
    .orderBy(desc(policy_violations.evaluated_at))
  return c.json(rows)
})

// ---------------------------------------------------------------------------
// POST / — create policy
// ---------------------------------------------------------------------------

router.post('/', authMiddleware, zValidator('json', policySchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')
  if (!(await ownsWorkspace(body.workspace_id, userId)))
    return c.json({ error: 'Forbidden' }, 403)
  const [p] = await db
    .insert(policies)
    .values({
      workspace_id: body.workspace_id,
      name: body.name,
      rule_type: body.rule_type,
      config: body.config as Record<string, unknown>,
      severity: body.severity,
      is_enabled: body.is_enabled,
      created_by: userId,
    })
    .returning()
  return c.json(p, 201)
})

// ---------------------------------------------------------------------------
// PUT /:id — update / enable / disable policy
// ---------------------------------------------------------------------------

router.put(
  '/:id',
  authMiddleware,
  zValidator('json', policySchema.partial().omit({ workspace_id: true })),
  async (c) => {
    const userId = getUserId(c)
    const id = c.req.param('id')
    const [existing] = await db.select().from(policies).where(eq(policies.id, id))
    if (!existing) return c.json({ error: 'Not found' }, 404)
    if (!(await ownsWorkspace(existing.workspace_id, userId)))
      return c.json({ error: 'Forbidden' }, 403)
    const body = c.req.valid('json')
    const patch: Record<string, unknown> = {}
    if (body.name !== undefined) patch.name = body.name
    if (body.rule_type !== undefined) patch.rule_type = body.rule_type
    if (body.config !== undefined) patch.config = body.config
    if (body.severity !== undefined) patch.severity = body.severity
    if (body.is_enabled !== undefined) patch.is_enabled = body.is_enabled
    const [updated] = await db
      .update(policies)
      .set(patch)
      .where(eq(policies.id, id))
      .returning()
    return c.json(updated)
  },
)

// ---------------------------------------------------------------------------
// POST /evaluate — evaluate every enabled policy for a workspace
// ---------------------------------------------------------------------------

router.post('/evaluate', authMiddleware, zValidator('json', evaluateSchema), async (c) => {
  const userId = getUserId(c)
  const { workspace_id } = c.req.valid('json')
  if (!(await ownsWorkspace(workspace_id, userId)))
    return c.json({ error: 'Forbidden' }, 403)

  const enabledPolicies = await db
    .select()
    .from(policies)
    .where(and(eq(policies.workspace_id, workspace_id), eq(policies.is_enabled, true)))

  const wsPipelines = await db
    .select()
    .from(pipelines)
    .where(eq(pipelines.workspace_id, workspace_id))
  const wsActions = await db.select().from(actions).where(eq(actions.workspace_id, workspace_id))
  const wsPipelineActions = await db
    .select()
    .from(pipeline_actions)
    .where(eq(pipeline_actions.workspace_id, workspace_id))
  const wsIdentities = await db
    .select()
    .from(pipeline_identities)
    .where(eq(pipeline_identities.workspace_id, workspace_id))
  const wsTrusts = await db
    .select()
    .from(oidc_trusts)
    .where(eq(oidc_trusts.workspace_id, workspace_id))
  const wsSecrets = await db.select().from(secrets).where(eq(secrets.workspace_id, workspace_id))

  const actionById = new Map(wsActions.map((a) => [a.id, a]))

  // Clear out previously-open violations for these policies so re-evaluation is
  // idempotent; exempted/resolved violations are preserved as an audit record.
  const policyIds = new Set(enabledPolicies.map((p) => p.id))
  const existingViolations = await db
    .select()
    .from(policy_violations)
    .where(eq(policy_violations.workspace_id, workspace_id))
  for (const v of existingViolations) {
    if (policyIds.has(v.policy_id) && v.status === 'open') {
      await db.delete(policy_violations).where(eq(policy_violations.id, v.id))
    }
  }

  let violations = 0
  const recordViolation = async (
    policyId: string,
    pipelineId: string | null,
    detail: string,
  ) => {
    await db.insert(policy_violations).values({
      workspace_id,
      policy_id: policyId,
      pipeline_id: pipelineId,
      status: 'open',
      detail,
    })
    violations++
  }

  for (const policy of enabledPolicies) {
    const cfg = (policy.config ?? {}) as Record<string, unknown>
    switch (policy.rule_type) {
      case 'no_write_all': {
        for (const p of wsPipelines) {
          const perms = (p.declared_permissions ?? {}) as Record<string, string>
          const writeAll =
            (perms['*'] && perms['*'] !== 'none') ||
            Object.values(perms).some((v) => v === 'write-all') ||
            (perms['contents'] === 'write' &&
              perms['packages'] === 'write' &&
              perms['id-token'] === 'write')
          if (writeAll) {
            await recordViolation(
              policy.id,
              p.id,
              `Pipeline "${p.name}" declares write-all / wildcard permissions: ${JSON.stringify(perms)}`,
            )
          }
        }
        break
      }
      case 'actions_pinned_sha': {
        for (const pa of wsPipelineActions) {
          const action = actionById.get(pa.action_id)
          if (!action) continue
          if (action.pin_type !== 'sha') {
            const pipeline = wsPipelines.find((p) => p.id === pa.pipeline_id)
            await recordViolation(
              policy.id,
              pa.pipeline_id,
              `Action "${action.name}" is pinned by ${action.pin_type} (${action.pin_ref || 'unset'}) in ${
                pipeline?.name ?? pa.pipeline_id
              }; require a commit SHA`,
            )
          }
        }
        break
      }
      case 'oidc_branch_scoped': {
        const identityById = new Map(wsIdentities.map((i) => [i.id, i]))
        for (const trust of wsTrusts) {
          if (!trust.is_branch_scoped) {
            const identity = trust.identity_id ? identityById.get(trust.identity_id) : undefined
            await recordViolation(
              policy.id,
              identity?.pipeline_id ?? null,
              `OIDC trust for issuer "${trust.issuer}" (sub: ${trust.sub_claim_pattern}) is not branch-scoped`,
            )
          }
        }
        break
      }
      case 'secret_rotation_max_days': {
        const maxDays =
          typeof cfg.max_days === 'number' ? (cfg.max_days as number) : 90
        for (const s of wsSecrets) {
          const age = s.rotation_age_days ?? 0
          if (age > maxDays) {
            await recordViolation(
              policy.id,
              null,
              `Secret "${s.name}" rotation age ${age}d exceeds max ${maxDays}d`,
            )
          }
        }
        break
      }
      case 'no_plaintext_secret': {
        for (const s of wsSecrets) {
          if (s.is_plaintext || s.store === 'plaintext' || !s.is_masked) {
            await recordViolation(
              policy.id,
              null,
              `Secret "${s.name}" is stored in plaintext or unmasked (store=${s.store}, masked=${s.is_masked})`,
            )
          }
        }
        break
      }
      default:
        break
    }
  }

  await db.insert(activity_log).values({
    workspace_id,
    actor_id: userId,
    action: 'policies.evaluate',
    entity_type: 'policy',
    entity_id: '',
    metadata: { violations, policies: enabledPolicies.length },
  })

  return c.json({ violations })
})

// ---------------------------------------------------------------------------
// POST /violations/:id/exempt — exempt a violation
// ---------------------------------------------------------------------------

router.post(
  '/violations/:id/exempt',
  authMiddleware,
  zValidator('json', exemptSchema),
  async (c) => {
    const userId = getUserId(c)
    const id = c.req.param('id')
    const { exemption_reason } = c.req.valid('json')
    const [v] = await db.select().from(policy_violations).where(eq(policy_violations.id, id))
    if (!v) return c.json({ error: 'Not found' }, 404)
    if (!(await ownsWorkspace(v.workspace_id, userId)))
      return c.json({ error: 'Forbidden' }, 403)
    const [updated] = await db
      .update(policy_violations)
      .set({ status: 'exempted', exemption_reason })
      .where(eq(policy_violations.id, id))
      .returning()

    await db.insert(activity_log).values({
      workspace_id: v.workspace_id,
      actor_id: userId,
      action: 'policy_violation.exempt',
      entity_type: 'policy_violation',
      entity_id: v.id,
      metadata: { policy_id: v.policy_id, reason: exemption_reason },
    })

    return c.json(updated)
  },
)

// ---------------------------------------------------------------------------
// DELETE /:id — delete a policy (and its violations)
// ---------------------------------------------------------------------------

router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(policies).where(eq(policies.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId)))
    return c.json({ error: 'Forbidden' }, 403)
  await db.delete(policy_violations).where(eq(policy_violations.policy_id, id))
  await db.delete(policies).where(eq(policies.id, id))
  return c.json({ success: true })
})

export default router
