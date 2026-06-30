import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  connections,
  providers,
  workspaces,
  pipelines,
  pipeline_identities,
  actions,
  pipeline_actions,
  secrets,
  secret_references,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

const createSchema = z.object({
  workspace_id: z.string().min(1),
  provider_id: z.string().min(1),
  label: z.string().min(1),
  scope: z.string().optional().default('read'),
  status: z.string().optional().default('idle'),
  config: z.record(z.string(), z.unknown()).optional().default({}),
})

/** Verify the caller owns the workspace. */
async function ownedWorkspace(workspaceId: string, userId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  if (!ws) return { ws: null, forbidden: false }
  if (ws.owner_id !== userId) return { ws, forbidden: true }
  return { ws, forbidden: false }
}

// ---------------------------------------------------------------------------
// Deterministic sync fixtures.
//
// A connection sync parses the provider's CI configuration and populates the
// pipelines / identities / actions / secrets tables. To keep this fully
// deterministic and self-contained (no network), we derive a fixed catalog of
// pipelines per provider kind. The same connection always yields the same rows
// (idempotent: re-sync upserts / re-creates the same set).
// ---------------------------------------------------------------------------

interface SyncActionSpec {
  name: string
  publisher: string
  pin_type: 'tag' | 'branch' | 'sha'
  pin_ref: string
  is_verified_publisher: boolean
  inherited_privileges: string[]
  risk_level: string
  is_deprecated: boolean
  step_name: string
}

interface SyncIdentitySpec {
  identity_type: string
  name: string
  credential_kind: string
  is_long_lived: boolean
  environment: string
  tags: string[]
}

interface SyncSecretSpec {
  name: string
  store: string
  is_scoped: boolean
  is_masked: boolean
  is_plaintext: boolean
  exposed_to_fork_pr: boolean
  usage_context: string
  is_logged: boolean
}

interface SyncPipelineSpec {
  name: string
  repo: string
  branch: string
  file_path: string
  triggers: string[]
  declared_permissions: Record<string, string>
  raw_source: string
  identities: SyncIdentitySpec[]
  actions: SyncActionSpec[]
  secrets: SyncSecretSpec[]
}

function fixturesFor(kind: string, org: string): SyncPipelineSpec[] {
  const ns = org && org.length > 0 ? org : 'acme'
  if (kind === 'github_actions') {
    return [
      {
        name: 'CI Build & Test',
        repo: `${ns}/web-app`,
        branch: 'main',
        file_path: '.github/workflows/ci.yml',
        triggers: ['push', 'pull_request'],
        declared_permissions: { contents: 'read', 'pull-requests': 'write' },
        raw_source:
          'name: CI\non: [push, pull_request]\npermissions:\n  contents: read\n  pull-requests: write\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: tj-actions/changed-files@v44',
        identities: [
          {
            identity_type: 'github_token',
            name: 'GITHUB_TOKEN',
            credential_kind: 'ephemeral',
            is_long_lived: false,
            environment: 'ci',
            tags: ['default'],
          },
        ],
        actions: [
          {
            name: 'actions/checkout',
            publisher: 'actions',
            pin_type: 'tag',
            pin_ref: 'v4',
            is_verified_publisher: true,
            inherited_privileges: ['contents:read'],
            risk_level: 'low',
            is_deprecated: false,
            step_name: 'Checkout',
          },
          {
            name: 'tj-actions/changed-files',
            publisher: 'tj-actions',
            pin_type: 'tag',
            pin_ref: 'v44',
            is_verified_publisher: false,
            inherited_privileges: ['contents:read'],
            risk_level: 'high',
            is_deprecated: false,
            step_name: 'Detect changes',
          },
        ],
        secrets: [
          {
            name: 'NPM_TOKEN',
            store: 'provider',
            is_scoped: false,
            is_masked: true,
            is_plaintext: false,
            exposed_to_fork_pr: true,
            usage_context: 'env',
            is_logged: false,
          },
        ],
      },
      {
        name: 'Deploy to Production',
        repo: `${ns}/web-app`,
        branch: 'main',
        file_path: '.github/workflows/deploy.yml',
        triggers: ['workflow_dispatch', 'release'],
        declared_permissions: { contents: 'write', 'id-token': 'write', packages: 'write' },
        raw_source:
          'name: Deploy\non:\n  workflow_dispatch:\npermissions:\n  contents: write\n  id-token: write\n  packages: write\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: aws-actions/configure-aws-credentials@v4',
        identities: [
          {
            identity_type: 'oidc_role',
            name: 'arn:aws:iam::123456789012:role/gha-deploy',
            credential_kind: 'oidc',
            is_long_lived: false,
            environment: 'production',
            tags: ['deploy', 'aws'],
          },
        ],
        actions: [
          {
            name: 'actions/checkout',
            publisher: 'actions',
            pin_type: 'tag',
            pin_ref: 'v4',
            is_verified_publisher: true,
            inherited_privileges: ['contents:read'],
            risk_level: 'low',
            is_deprecated: false,
            step_name: 'Checkout',
          },
          {
            name: 'aws-actions/configure-aws-credentials',
            publisher: 'aws-actions',
            pin_type: 'tag',
            pin_ref: 'v4',
            is_verified_publisher: true,
            inherited_privileges: ['sts:AssumeRoleWithWebIdentity'],
            risk_level: 'medium',
            is_deprecated: false,
            step_name: 'Configure AWS',
          },
        ],
        secrets: [
          {
            name: 'AWS_ACCOUNT_ID',
            store: 'provider',
            is_scoped: true,
            is_masked: true,
            is_plaintext: false,
            exposed_to_fork_pr: false,
            usage_context: 'env',
            is_logged: false,
          },
        ],
      },
    ]
  }
  if (kind === 'gitlab_ci') {
    return [
      {
        name: 'gitlab-pipeline',
        repo: `${ns}/api-service`,
        branch: 'main',
        file_path: '.gitlab-ci.yml',
        triggers: ['push', 'merge_request'],
        declared_permissions: { registry: 'write', deploy: 'read' },
        raw_source:
          'stages:\n  - build\n  - deploy\nbuild:\n  stage: build\n  script:\n    - docker build -t $CI_REGISTRY_IMAGE .\ndeploy:\n  stage: deploy\n  script:\n    - ./deploy.sh',
        identities: [
          {
            identity_type: 'service_account',
            name: 'gitlab-ci-runner',
            credential_kind: 'ci_job_token',
            is_long_lived: false,
            environment: 'ci',
            tags: ['runner'],
          },
          {
            identity_type: 'stored_credential',
            name: 'DEPLOY_SSH_KEY',
            credential_kind: 'ssh_key',
            is_long_lived: true,
            environment: 'production',
            tags: ['deploy'],
          },
        ],
        actions: [],
        secrets: [
          {
            name: 'CI_REGISTRY_PASSWORD',
            store: 'provider',
            is_scoped: true,
            is_masked: true,
            is_plaintext: false,
            exposed_to_fork_pr: false,
            usage_context: 'env',
            is_logged: false,
          },
          {
            name: 'DEPLOY_SSH_KEY',
            store: 'plaintext',
            is_scoped: false,
            is_masked: false,
            is_plaintext: true,
            exposed_to_fork_pr: false,
            usage_context: 'file',
            is_logged: false,
          },
        ],
      },
    ]
  }
  if (kind === 'jenkins') {
    return [
      {
        name: 'jenkins-main',
        repo: `${ns}/monolith`,
        branch: 'master',
        file_path: 'Jenkinsfile',
        triggers: ['scm_poll', 'manual'],
        declared_permissions: { deploy: 'write', cloud: 'write' },
        raw_source:
          "pipeline {\n  agent any\n  stages {\n    stage('Build') { steps { sh 'make build' } }\n    stage('Deploy') { steps { withCredentials([string(credentialsId: 'aws-key', variable: 'AWS_KEY')]) { sh './deploy.sh' } } }\n  }\n}",
        identities: [
          {
            identity_type: 'stored_credential',
            name: 'jenkins-aws-admin',
            credential_kind: 'access_key',
            is_long_lived: true,
            environment: 'production',
            tags: ['admin', 'aws'],
          },
        ],
        actions: [],
        secrets: [
          {
            name: 'aws-key',
            store: 'vault',
            is_scoped: false,
            is_masked: true,
            is_plaintext: false,
            exposed_to_fork_pr: false,
            usage_context: 'env',
            is_logged: true,
          },
        ],
      },
    ]
  }
  // Fallback: a single generic pipeline.
  return [
    {
      name: 'pipeline',
      repo: `${ns}/repo`,
      branch: 'main',
      file_path: 'pipeline.yml',
      triggers: ['push'],
      declared_permissions: { contents: 'read' },
      raw_source: 'steps:\n  - run: echo build',
      identities: [
        {
          identity_type: 'stored_credential',
          name: 'ci-credential',
          credential_kind: 'token',
          is_long_lived: true,
          environment: 'ci',
          tags: [],
        },
      ],
      actions: [],
      secrets: [],
    },
  ]
}

/** Deterministic risk score from a pipeline spec (0..100). */
function riskFor(spec: SyncPipelineSpec): number {
  let score = 0
  for (const [, level] of Object.entries(spec.declared_permissions)) {
    if (level === 'write') score += 15
    else score += 4
  }
  for (const a of spec.actions) {
    if (a.risk_level === 'high') score += 20
    else if (a.risk_level === 'medium') score += 10
    else score += 3
    if (a.pin_type !== 'sha') score += 5
    if (!a.is_verified_publisher) score += 8
  }
  for (const id of spec.identities) {
    if (id.is_long_lived) score += 12
  }
  for (const s of spec.secrets) {
    if (s.is_plaintext) score += 15
    if (s.exposed_to_fork_pr) score += 10
    if (!s.is_masked) score += 6
  }
  return Math.min(100, Math.round(score))
}

// Public: list connections, optionally scoped by workspace_id / provider_id.
router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const providerId = c.req.query('provider_id')
  const conds = []
  if (workspaceId) conds.push(eq(connections.workspace_id, workspaceId))
  if (providerId) conds.push(eq(connections.provider_id, providerId))
  const rows =
    conds.length > 0
      ? await db.select().from(connections).where(and(...conds)).orderBy(desc(connections.created_at))
      : await db.select().from(connections).orderBy(desc(connections.created_at))
  return c.json(rows)
})

// Public: connection detail.
router.get('/:id', async (c) => {
  const [conn] = await db.select().from(connections).where(eq(connections.id, c.req.param('id')))
  if (!conn) return c.json({ error: 'Not found' }, 404)
  return c.json(conn)
})

// Auth + workspace owner: create connection.
router.post('/', authMiddleware, zValidator('json', createSchema), async (c) => {
  const userId = getUserId(c)
  const body = c.req.valid('json')
  const { ws, forbidden } = await ownedWorkspace(body.workspace_id, userId)
  if (!ws) return c.json({ error: 'Workspace not found' }, 404)
  if (forbidden) return c.json({ error: 'Forbidden' }, 403)
  // Provider must exist and belong to the same workspace.
  const [provider] = await db.select().from(providers).where(eq(providers.id, body.provider_id))
  if (!provider) return c.json({ error: 'Provider not found' }, 404)
  if (provider.workspace_id !== body.workspace_id) {
    return c.json({ error: 'Provider does not belong to workspace' }, 400)
  }
  const [conn] = await db
    .insert(connections)
    .values({
      workspace_id: body.workspace_id,
      provider_id: body.provider_id,
      label: body.label,
      scope: body.scope ?? 'read',
      status: body.status ?? 'idle',
      config: body.config ?? {},
      created_by: userId,
    })
    .returning()
  return c.json(conn, 201)
})

// Auth + workspace owner: trigger a deterministic sync. Parses the provider's
// CI configuration and (re)populates pipelines / identities / actions /
// secrets for this connection's workspace.
router.post('/:id/sync', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [conn] = await db.select().from(connections).where(eq(connections.id, id))
  if (!conn) return c.json({ error: 'Not found' }, 404)
  const { forbidden } = await ownedWorkspace(conn.workspace_id, userId)
  if (forbidden) return c.json({ error: 'Forbidden' }, 403)

  const [provider] = await db.select().from(providers).where(eq(providers.id, conn.provider_id))
  if (!provider) {
    await db
      .update(connections)
      .set({ status: 'error', last_error: 'Provider not found' })
      .where(eq(connections.id, id))
    return c.json({ error: 'Provider not found' }, 404)
  }

  const wsId = conn.workspace_id
  const now = new Date()

  try {
    const specs = fixturesFor(provider.kind, provider.org ?? '')

    for (const spec of specs) {
      // Pipeline: upsert by (workspace_id, provider_id, repo, file_path).
      const existingPipelines = await db
        .select()
        .from(pipelines)
        .where(and(eq(pipelines.workspace_id, wsId), eq(pipelines.provider_id, provider.id)))
      const existingPipeline = existingPipelines.find(
        (p) => p.repo === spec.repo && p.file_path === spec.file_path,
      )

      const pipelineValues = {
        workspace_id: wsId,
        provider_id: provider.id,
        name: spec.name,
        repo: spec.repo,
        branch: spec.branch,
        file_path: spec.file_path,
        triggers: spec.triggers,
        declared_permissions: spec.declared_permissions,
        raw_source: spec.raw_source,
        risk_score: riskFor(spec),
        last_seen_at: now,
      }

      let pipelineId: string
      if (existingPipeline) {
        const [updated] = await db
          .update(pipelines)
          .set(pipelineValues)
          .where(eq(pipelines.id, existingPipeline.id))
          .returning()
        pipelineId = updated.id
        // Clear stale child rows so re-sync is idempotent.
        await db.delete(pipeline_identities).where(eq(pipeline_identities.pipeline_id, pipelineId))
        await db.delete(pipeline_actions).where(eq(pipeline_actions.pipeline_id, pipelineId))
        await db.delete(secret_references).where(eq(secret_references.pipeline_id, pipelineId))
      } else {
        const [created] = await db.insert(pipelines).values(pipelineValues).returning()
        pipelineId = created.id
      }

      // Identities.
      for (const idSpec of spec.identities) {
        await db.insert(pipeline_identities).values({
          workspace_id: wsId,
          pipeline_id: pipelineId,
          identity_type: idSpec.identity_type,
          name: idSpec.name,
          credential_kind: idSpec.credential_kind,
          is_long_lived: idSpec.is_long_lived,
          environment: idSpec.environment,
          tags: idSpec.tags,
          last_active_at: now,
        })
      }

      // Actions (workspace-level, upserted by (workspace_id, name, pin_ref)) +
      // pipeline_actions linkage.
      for (const aSpec of spec.actions) {
        const [action] = await db
          .insert(actions)
          .values({
            workspace_id: wsId,
            name: aSpec.name,
            publisher: aSpec.publisher,
            pin_type: aSpec.pin_type,
            pin_ref: aSpec.pin_ref,
            is_verified_publisher: aSpec.is_verified_publisher,
            inherited_privileges: aSpec.inherited_privileges,
            risk_level: aSpec.risk_level,
            usage_count: 1,
            is_deprecated: aSpec.is_deprecated,
          })
          .onConflictDoUpdate({
            target: [actions.workspace_id, actions.name, actions.pin_ref],
            set: {
              publisher: aSpec.publisher,
              pin_type: aSpec.pin_type,
              is_verified_publisher: aSpec.is_verified_publisher,
              inherited_privileges: aSpec.inherited_privileges,
              risk_level: aSpec.risk_level,
              is_deprecated: aSpec.is_deprecated,
            },
          })
          .returning()

        await db
          .insert(pipeline_actions)
          .values({
            workspace_id: wsId,
            pipeline_id: pipelineId,
            action_id: action.id,
            step_name: aSpec.step_name,
            inherited_privileges: aSpec.inherited_privileges,
          })
          .onConflictDoNothing({
            target: [pipeline_actions.pipeline_id, pipeline_actions.action_id, pipeline_actions.step_name],
          })
      }

      // Secrets (workspace-level, upserted by (workspace_id, name)) +
      // secret_references linkage.
      for (const sSpec of spec.secrets) {
        const [secret] = await db
          .insert(secrets)
          .values({
            workspace_id: wsId,
            name: sSpec.name,
            store: sSpec.store,
            is_scoped: sSpec.is_scoped,
            is_masked: sSpec.is_masked,
            is_plaintext: sSpec.is_plaintext,
            exposed_to_fork_pr: sSpec.exposed_to_fork_pr,
          })
          .onConflictDoUpdate({
            target: [secrets.workspace_id, secrets.name],
            set: {
              store: sSpec.store,
              is_scoped: sSpec.is_scoped,
              is_masked: sSpec.is_masked,
              is_plaintext: sSpec.is_plaintext,
              exposed_to_fork_pr: sSpec.exposed_to_fork_pr,
            },
          })
          .returning()

        await db
          .insert(secret_references)
          .values({
            workspace_id: wsId,
            secret_id: secret.id,
            pipeline_id: pipelineId,
            usage_context: sSpec.usage_context,
            is_logged: sSpec.is_logged,
          })
          .onConflictDoNothing({
            target: [secret_references.secret_id, secret_references.pipeline_id, secret_references.usage_context],
          })
      }
    }

    const [updatedConn] = await db
      .update(connections)
      .set({ status: 'ok', last_synced_at: now, last_error: '' })
      .where(eq(connections.id, id))
      .returning()
    return c.json(updatedConn)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const [errConn] = await db
      .update(connections)
      .set({ status: 'error', last_error: msg })
      .where(eq(connections.id, id))
      .returning()
    return c.json(errConn ?? { error: msg }, 500)
  }
})

// Auth + workspace owner: delete connection.
router.delete('/:id', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const [existing] = await db.select().from(connections).where(eq(connections.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const { forbidden } = await ownedWorkspace(existing.workspace_id, userId)
  if (forbidden) return c.json({ error: 'Forbidden' }, 403)
  await db.delete(connections).where(eq(connections.id, id))
  return c.json({ success: true })
})

export default router
