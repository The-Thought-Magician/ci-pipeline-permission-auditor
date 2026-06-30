import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  evidence_packs,
  workspaces,
  pipelines,
  pipeline_identities,
  oidc_trusts,
  roles,
  permissions,
  resources,
  actions,
  secrets,
  findings,
  recommendations,
  drift_events,
  policies,
  policy_violations,
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
// Control catalog — the SOC2 / SLSA controls we evaluate.
// ---------------------------------------------------------------------------

interface ControlDef {
  framework: 'soc2' | 'slsa'
  control: string
  title: string
  /** Returns 'passing' | 'failing' given evaluated workspace facts. */
  evaluate: (facts: WorkspaceFacts) => { status: 'passing' | 'failing'; detail: string }
}

interface WorkspaceFacts {
  pipelines: (typeof pipelines.$inferSelect)[]
  actions: (typeof actions.$inferSelect)[]
  secrets: (typeof secrets.$inferSelect)[]
  trusts: (typeof oidc_trusts.$inferSelect)[]
  findings: (typeof findings.$inferSelect)[]
  identities: (typeof pipeline_identities.$inferSelect)[]
}

const CONTROLS: ControlDef[] = [
  {
    framework: 'soc2',
    control: 'CC6.1',
    title: 'Logical access — least privilege on CI permissions',
    evaluate: (f) => {
      const overPriv = f.findings.filter(
        (x) => x.detector === 'over_privilege' && x.status === 'open',
      )
      return overPriv.length === 0
        ? { status: 'passing', detail: 'No open over-privilege findings' }
        : { status: 'failing', detail: `${overPriv.length} open over-privilege finding(s)` }
    },
  },
  {
    framework: 'soc2',
    control: 'CC6.3',
    title: 'Credential management — no long-lived/plaintext secrets',
    evaluate: (f) => {
      const bad = f.secrets.filter((s) => s.is_plaintext || s.store === 'plaintext' || !s.is_masked)
      return bad.length === 0
        ? { status: 'passing', detail: 'All secrets masked and stored securely' }
        : { status: 'failing', detail: `${bad.length} secret(s) plaintext or unmasked` }
    },
  },
  {
    framework: 'soc2',
    control: 'CC7.2',
    title: 'Monitoring — secret rotation within policy window',
    evaluate: (f) => {
      const stale = f.secrets.filter((s) => (s.rotation_age_days ?? 0) > 90)
      return stale.length === 0
        ? { status: 'passing', detail: 'All secrets rotated within 90 days' }
        : { status: 'failing', detail: `${stale.length} secret(s) overdue for rotation` }
    },
  },
  {
    framework: 'slsa',
    control: 'slsa_l3_pinned_deps',
    title: 'SLSA L3 — third-party actions pinned to immutable SHA',
    evaluate: (f) => {
      const unpinned = f.actions.filter((a) => a.pin_type !== 'sha')
      return unpinned.length === 0
        ? { status: 'passing', detail: 'All actions pinned to SHA' }
        : { status: 'failing', detail: `${unpinned.length} action(s) not SHA-pinned` }
    },
  },
  {
    framework: 'slsa',
    control: 'slsa_l3_isolated_build',
    title: 'SLSA L3 — branch-scoped OIDC trust (no ambient credentials)',
    evaluate: (f) => {
      const unscoped = f.trusts.filter((t) => !t.is_branch_scoped)
      return unscoped.length === 0
        ? { status: 'passing', detail: 'All OIDC trusts branch-scoped' }
        : { status: 'failing', detail: `${unscoped.length} OIDC trust(s) not branch-scoped` }
    },
  },
  {
    framework: 'slsa',
    control: 'slsa_l2_provenance',
    title: 'SLSA L2 — no secrets exposed to fork PR builds',
    evaluate: (f) => {
      const exposed = f.secrets.filter((s) => s.exposed_to_fork_pr)
      return exposed.length === 0
        ? { status: 'passing', detail: 'No secrets exposed to fork PRs' }
        : { status: 'failing', detail: `${exposed.length} secret(s) exposed to fork PRs` }
    },
  },
]

async function loadFacts(workspaceId: string): Promise<WorkspaceFacts> {
  const [pipes, acts, secs, trusts, finds, idents] = await Promise.all([
    db.select().from(pipelines).where(eq(pipelines.workspace_id, workspaceId)),
    db.select().from(actions).where(eq(actions.workspace_id, workspaceId)),
    db.select().from(secrets).where(eq(secrets.workspace_id, workspaceId)),
    db.select().from(oidc_trusts).where(eq(oidc_trusts.workspace_id, workspaceId)),
    db.select().from(findings).where(eq(findings.workspace_id, workspaceId)),
    db.select().from(pipeline_identities).where(eq(pipeline_identities.workspace_id, workspaceId)),
  ])
  return {
    pipelines: pipes,
    actions: acts,
    secrets: secs,
    trusts,
    findings: finds,
    identities: idents,
  }
}

function controlTitle(framework: string, control: string): string {
  const def = CONTROLS.find((c) => c.framework === framework && c.control === control)
  return def ? def.title : `${framework.toUpperCase()} ${control}`
}

// ---------------------------------------------------------------------------
// GET / — list evidence packs (public)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const framework = c.req.query('framework')

  const conds = []
  if (workspaceId) conds.push(eq(evidence_packs.workspace_id, workspaceId))
  if (framework) conds.push(eq(evidence_packs.framework, framework))

  const rows = await db
    .select()
    .from(evidence_packs)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(evidence_packs.generated_at))
  return c.json(rows)
})

// ---------------------------------------------------------------------------
// GET /coverage — control coverage view (public)
// (declared BEFORE /:id so "coverage" is not captured as an id)
// ---------------------------------------------------------------------------

router.get('/coverage', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  if (!workspaceId) return c.json({ error: 'workspace_id is required' }, 400)

  const facts = await loadFacts(workspaceId)
  const coverage = CONTROLS.map((ctrl) => {
    const result = ctrl.evaluate(facts)
    return {
      framework: ctrl.framework,
      control: ctrl.control,
      title: ctrl.title,
      status: result.status,
      detail: result.detail,
    }
  })
  return c.json(coverage)
})

// ---------------------------------------------------------------------------
// GET /:id — evidence pack detail (public, full contents)
// ---------------------------------------------------------------------------

router.get('/:id', async (c) => {
  const [pack] = await db.select().from(evidence_packs).where(eq(evidence_packs.id, c.req.param('id')))
  if (!pack) return c.json({ error: 'Not found' }, 404)
  return c.json(pack)
})

// ---------------------------------------------------------------------------
// POST /generate — generate a pack for a framework/control (auth + owner)
// ---------------------------------------------------------------------------

const generateSchema = z.object({
  workspace_id: z.string().min(1),
  framework: z.enum(['soc2', 'slsa']),
  control: z.string().min(1),
})

router.post('/generate', authMiddleware, zValidator('json', generateSchema), async (c) => {
  const userId = getUserId(c)
  const { workspace_id, framework, control } = c.req.valid('json')

  const { owned } = await getWorkspaceIfOwned(workspace_id, userId)
  if (!owned) return c.json({ error: 'Forbidden' }, 403)

  const facts = await loadFacts(workspace_id)

  // Status for this specific control (if it is one we recognise).
  const ctrlDef = CONTROLS.find((x) => x.framework === framework && x.control === control)
  const ctrlResult = ctrlDef
    ? ctrlDef.evaluate(facts)
    : { status: 'draft' as const, detail: 'Control not in catalog; bundled raw evidence' }

  // Bundle full evidence: inventory + findings + secrets + drift + remediation.
  const [
    allRoles,
    allPerms,
    allResources,
    allRecs,
    allDrift,
    allPolicies,
    allViolations,
  ] = await Promise.all([
    db.select().from(roles).where(eq(roles.workspace_id, workspace_id)),
    db.select().from(permissions).where(eq(permissions.workspace_id, workspace_id)),
    db.select().from(resources).where(eq(resources.workspace_id, workspace_id)),
    db.select().from(recommendations).where(eq(recommendations.workspace_id, workspace_id)),
    db.select().from(drift_events).where(eq(drift_events.workspace_id, workspace_id)),
    db.select().from(policies).where(eq(policies.workspace_id, workspace_id)),
    db.select().from(policy_violations).where(eq(policy_violations.workspace_id, workspace_id)),
  ])

  const contents = {
    framework,
    control,
    generated_at: new Date().toISOString(),
    result: ctrlResult,
    inventory: {
      pipelines: facts.pipelines,
      identities: facts.identities,
      oidc_trusts: facts.trusts,
      roles: allRoles,
      permissions: allPerms,
      resources: allResources,
      actions: facts.actions,
    },
    findings: facts.findings,
    secrets: facts.secrets,
    drift: allDrift,
    policies: allPolicies,
    policy_violations: allViolations,
    remediation: allRecs,
    coverage: CONTROLS.map((ctrl) => {
      const r = ctrl.evaluate(facts)
      return { framework: ctrl.framework, control: ctrl.control, status: r.status, detail: r.detail }
    }),
  }

  const shareToken = crypto.randomUUID().replace(/-/g, '')
  const status = ctrlDef ? ctrlResult.status : 'draft'

  const [pack] = await db
    .insert(evidence_packs)
    .values({
      workspace_id,
      framework,
      control,
      title: controlTitle(framework, control),
      status,
      contents,
      share_token: shareToken,
      created_by: userId,
    })
    .returning()

  return c.json(pack, 201)
})

// ---------------------------------------------------------------------------
// DELETE /:id — delete pack (auth + owner)
// ---------------------------------------------------------------------------

router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(evidence_packs).where(eq(evidence_packs.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const { owned } = await getWorkspaceIfOwned(existing.workspace_id, userId)
  if (!owned) return c.json({ error: 'Forbidden' }, 403)
  await db.delete(evidence_packs).where(eq(evidence_packs.id, id))
  return c.json({ success: true })
})

export default router
