import { Hono } from 'hono'
import { db } from '../db/index.js'
import {
  workspaces,
  teams,
  providers,
  connections,
  pipelines,
  pipeline_identities,
  oidc_trusts,
  roles,
  permissions,
  resources,
  actions,
  pipeline_actions,
  secrets,
  secret_references,
  effective_permissions,
  blast_radius,
  attack_paths,
  findings,
  recommendations,
  policies,
  policy_violations,
  snapshots,
  drift_events,
  audits,
  evidence_packs,
  reports,
  alerts,
  notifications,
  activity_log,
} from '../db/schema.js'
import { eq, and } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// The sample workspace is identified deterministically per user so the seed is
// idempotent (re-seeding tears down first) and the teardown can find it.
function sampleSlug(userId: string): string {
  // Slugs are workspace-unique; namespace by user to avoid collisions.
  const safe = userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || 'user'
  return `sample-${safe}`
}

// ---------------------------------------------------------------------------
// Teardown helper — deletes the sample workspace and all child rows in FK order.
// ---------------------------------------------------------------------------
async function teardownSampleWorkspace(workspaceId: string): Promise<void> {
  // Delete in reverse-dependency order so FK references are satisfied.
  await db.delete(secret_references).where(eq(secret_references.workspace_id, workspaceId))
  await db.delete(pipeline_actions).where(eq(pipeline_actions.workspace_id, workspaceId))
  await db.delete(effective_permissions).where(eq(effective_permissions.workspace_id, workspaceId))
  await db.delete(attack_paths).where(eq(attack_paths.workspace_id, workspaceId))
  await db.delete(blast_radius).where(eq(blast_radius.workspace_id, workspaceId))
  await db.delete(recommendations).where(eq(recommendations.workspace_id, workspaceId))
  await db.delete(policy_violations).where(eq(policy_violations.workspace_id, workspaceId))
  await db.delete(drift_events).where(eq(drift_events.workspace_id, workspaceId))
  await db.delete(findings).where(eq(findings.workspace_id, workspaceId))
  await db.delete(permissions).where(eq(permissions.workspace_id, workspaceId))
  await db.delete(oidc_trusts).where(eq(oidc_trusts.workspace_id, workspaceId))
  await db.delete(secrets).where(eq(secrets.workspace_id, workspaceId))
  await db.delete(pipeline_identities).where(eq(pipeline_identities.workspace_id, workspaceId))
  await db.delete(actions).where(eq(actions.workspace_id, workspaceId))
  await db.delete(resources).where(eq(resources.workspace_id, workspaceId))
  await db.delete(roles).where(eq(roles.workspace_id, workspaceId))
  await db.delete(pipelines).where(eq(pipelines.workspace_id, workspaceId))
  await db.delete(connections).where(eq(connections.workspace_id, workspaceId))
  await db.delete(providers).where(eq(providers.workspace_id, workspaceId))
  await db.delete(snapshots).where(eq(snapshots.workspace_id, workspaceId))
  await db.delete(audits).where(eq(audits.workspace_id, workspaceId))
  await db.delete(evidence_packs).where(eq(evidence_packs.workspace_id, workspaceId))
  await db.delete(reports).where(eq(reports.workspace_id, workspaceId))
  await db.delete(policies).where(eq(policies.workspace_id, workspaceId))
  await db.delete(alerts).where(eq(alerts.workspace_id, workspaceId))
  await db.delete(notifications).where(eq(notifications.workspace_id, workspaceId))
  await db.delete(activity_log).where(eq(activity_log.workspace_id, workspaceId))
  await db.delete(teams).where(eq(teams.workspace_id, workspaceId))
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
}

// ---------------------------------------------------------------------------
// POST /sample — seed a fully-populated demo workspace for the header user.
// ---------------------------------------------------------------------------
router.post('/sample', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const slug = sampleSlug(userId)

  // Idempotent: if a sample workspace already exists for this user, tear it down.
  const [existing] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.slug, slug), eq(workspaces.owner_id, userId)))
  if (existing) await teardownSampleWorkspace(existing.id)

  const now = Date.now()
  const iso = (offsetDays: number) => new Date(now + offsetDays * 86_400_000)

  // --- Workspace -----------------------------------------------------------
  const [workspace] = await db
    .insert(workspaces)
    .values({
      name: 'Acme CI Posture (Sample)',
      slug,
      owner_id: userId,
      description: 'Auto-generated demo workspace showcasing the full CI permission posture pipeline.',
      severity_thresholds: { critical: 90, high: 70, medium: 40, low: 0 },
      rotation_age_days: 90,
    })
    .returning()
  const wid = workspace.id

  // --- Teams ---------------------------------------------------------------
  const [platformTeam, appsTeam] = await db
    .insert(teams)
    .values([
      {
        workspace_id: wid,
        name: 'Platform',
        slug: 'platform',
        owner_email: 'platform@acme.example',
        member_ids: [userId],
        created_by: userId,
      },
      {
        workspace_id: wid,
        name: 'Applications',
        slug: 'applications',
        owner_email: 'apps@acme.example',
        member_ids: [userId],
        created_by: userId,
      },
    ])
    .returning()

  // --- Providers -----------------------------------------------------------
  const [ghProvider, glProvider] = await db
    .insert(providers)
    .values([
      {
        workspace_id: wid,
        kind: 'github_actions',
        name: 'GitHub — acme-corp',
        base_url: 'https://github.com',
        org: 'acme-corp',
        status: 'connected',
        created_by: userId,
      },
      {
        workspace_id: wid,
        kind: 'gitlab_ci',
        name: 'GitLab — acme',
        base_url: 'https://gitlab.com',
        org: 'acme',
        status: 'connected',
        created_by: userId,
      },
    ])
    .returning()

  // --- Connections ---------------------------------------------------------
  await db.insert(connections).values([
    {
      workspace_id: wid,
      provider_id: ghProvider.id,
      label: 'acme-corp org sync',
      scope: 'read',
      status: 'ok',
      last_synced_at: iso(-1),
      config: { repos: ['acme-corp/api', 'acme-corp/web', 'acme-corp/infra'] },
      created_by: userId,
    },
    {
      workspace_id: wid,
      provider_id: glProvider.id,
      label: 'acme group sync',
      scope: 'read',
      status: 'ok',
      last_synced_at: iso(-2),
      config: { group: 'acme' },
      created_by: userId,
    },
  ])

  // --- Resources -----------------------------------------------------------
  const [s3Prod, ecrProd, dbProd, repoApi] = await db
    .insert(resources)
    .values([
      {
        workspace_id: wid,
        name: 'prod-artifacts',
        kind: 'cloud',
        identifier: 'arn:aws:s3:::acme-prod-artifacts',
        is_crown_jewel: true,
        environment: 'production',
        tags: ['s3', 'artifacts'],
      },
      {
        workspace_id: wid,
        name: 'prod-ecr',
        kind: 'registry',
        identifier: 'acme.dkr.ecr.us-east-1.amazonaws.com/app',
        is_crown_jewel: true,
        environment: 'production',
        tags: ['ecr', 'images'],
      },
      {
        workspace_id: wid,
        name: 'prod-db-secrets',
        kind: 'secret',
        identifier: 'arn:aws:secretsmanager:us-east-1:acme:secret/prod-db',
        is_crown_jewel: true,
        environment: 'production',
        tags: ['rds', 'secret'],
      },
      {
        workspace_id: wid,
        name: 'acme-corp/api',
        kind: 'repo',
        identifier: 'github.com/acme-corp/api',
        is_crown_jewel: false,
        environment: 'production',
        tags: ['repo'],
      },
    ])
    .returning()

  // --- Roles ---------------------------------------------------------------
  const [deployRole, adminRole, readRole] = await db
    .insert(roles)
    .values([
      {
        workspace_id: wid,
        name: 'ci-deploy-prod',
        cloud: 'aws',
        arn: 'arn:aws:iam::acme:role/ci-deploy-prod',
        policy_summary: { managed: ['AmazonS3FullAccess', 'AmazonECRFullAccess'] },
        is_privileged: true,
      },
      {
        workspace_id: wid,
        name: 'ci-admin',
        cloud: 'aws',
        arn: 'arn:aws:iam::acme:role/ci-admin',
        policy_summary: { managed: ['AdministratorAccess'] },
        is_privileged: true,
      },
      {
        workspace_id: wid,
        name: 'ci-read-only',
        cloud: 'aws',
        arn: 'arn:aws:iam::acme:role/ci-read-only',
        policy_summary: { managed: ['ReadOnlyAccess'] },
        is_privileged: false,
      },
    ])
    .returning()

  // --- Pipelines -----------------------------------------------------------
  const [deployPipeline, testPipeline, releasePipeline] = await db
    .insert(pipelines)
    .values([
      {
        workspace_id: wid,
        provider_id: ghProvider.id,
        team_id: platformTeam.id,
        name: 'deploy-prod',
        repo: 'acme-corp/api',
        branch: 'main',
        file_path: '.github/workflows/deploy.yml',
        triggers: ['push', 'workflow_dispatch'],
        declared_permissions: { contents: 'read', 'id-token': 'write', packages: 'write' },
        raw_source: 'name: deploy\non:\n  push:\n    branches: [main]\npermissions:\n  contents: read\n  id-token: write\n  packages: write\n',
        risk_score: 82.5,
        last_seen_at: iso(-1),
      },
      {
        workspace_id: wid,
        provider_id: ghProvider.id,
        team_id: appsTeam.id,
        name: 'ci-test',
        repo: 'acme-corp/web',
        branch: 'main',
        file_path: '.github/workflows/test.yml',
        triggers: ['pull_request'],
        declared_permissions: { contents: 'write' },
        raw_source: 'name: test\non: [pull_request]\npermissions:\n  contents: write\n',
        risk_score: 48.0,
        last_seen_at: iso(-1),
      },
      {
        workspace_id: wid,
        provider_id: glProvider.id,
        team_id: platformTeam.id,
        name: 'release',
        repo: 'acme/infra',
        branch: 'main',
        file_path: '.gitlab-ci.yml',
        triggers: ['tag'],
        declared_permissions: {},
        raw_source: 'release:\n  script: ./release.sh\n',
        risk_score: 91.0,
        last_seen_at: iso(-3),
      },
    ])
    .returning()

  // --- Identities ----------------------------------------------------------
  const [oidcIdentity, tokenIdentity, saIdentity] = await db
    .insert(pipeline_identities)
    .values([
      {
        workspace_id: wid,
        pipeline_id: deployPipeline.id,
        identity_type: 'oidc_role',
        name: 'gha-oidc -> ci-deploy-prod',
        credential_kind: 'oidc',
        is_long_lived: false,
        environment: 'production',
        tags: ['oidc', 'aws'],
        last_active_at: iso(-1),
      },
      {
        workspace_id: wid,
        pipeline_id: testPipeline.id,
        identity_type: 'github_token',
        name: 'GITHUB_TOKEN (ci-test)',
        credential_kind: 'github_token',
        is_long_lived: false,
        environment: 'ci',
        tags: ['github'],
        last_active_at: iso(-1),
      },
      {
        workspace_id: wid,
        pipeline_id: releasePipeline.id,
        identity_type: 'stored_credential',
        name: 'AWS access key (release)',
        credential_kind: 'static_key',
        is_long_lived: true,
        environment: 'production',
        tags: ['static', 'aws', 'legacy'],
        last_active_at: iso(-30),
      },
    ])
    .returning()

  // --- OIDC trusts ---------------------------------------------------------
  await db.insert(oidc_trusts).values([
    {
      workspace_id: wid,
      identity_id: oidcIdentity.id,
      issuer: 'https://token.actions.githubusercontent.com',
      audience: 'sts.amazonaws.com',
      sub_claim_pattern: 'repo:acme-corp/api:ref:refs/heads/main',
      is_branch_scoped: true,
      assumable_role_ids: [deployRole.id],
    },
    {
      workspace_id: wid,
      identity_id: saIdentity.id,
      issuer: 'https://token.actions.githubusercontent.com',
      audience: 'sts.amazonaws.com',
      sub_claim_pattern: 'repo:acme/infra:*',
      is_branch_scoped: false,
      assumable_role_ids: [adminRole.id],
    },
  ])

  // --- Permissions ---------------------------------------------------------
  await db.insert(permissions).values([
    {
      workspace_id: wid,
      role_id: deployRole.id,
      identity_id: oidcIdentity.id,
      resource_id: s3Prod.id,
      action: 's3:PutObject',
      effect: 'allow',
      category: 'cloud',
      is_declared: true,
      is_wildcard: false,
    },
    {
      workspace_id: wid,
      role_id: deployRole.id,
      identity_id: oidcIdentity.id,
      resource_id: ecrProd.id,
      action: 'ecr:*',
      effect: 'allow',
      category: 'registry',
      is_declared: true,
      is_wildcard: true,
    },
    {
      workspace_id: wid,
      role_id: adminRole.id,
      identity_id: saIdentity.id,
      resource_id: dbProd.id,
      action: '*',
      effect: 'allow',
      category: 'cloud',
      is_declared: false,
      is_wildcard: true,
    },
    {
      workspace_id: wid,
      role_id: readRole.id,
      identity_id: tokenIdentity.id,
      resource_id: repoApi.id,
      action: 'contents:write',
      effect: 'allow',
      category: 'repo',
      is_declared: true,
      is_wildcard: false,
    },
  ])

  // --- Actions (third-party) ----------------------------------------------
  const [checkoutAction, changedFilesAction, awsCredsAction] = await db
    .insert(actions)
    .values([
      {
        workspace_id: wid,
        name: 'actions/checkout',
        publisher: 'github',
        pin_type: 'sha',
        pin_ref: 'b4ffde65f46336ab88eb53be808477a3936bae11',
        is_verified_publisher: true,
        inherited_privileges: ['contents:read'],
        risk_level: 'low',
        usage_count: 3,
        is_deprecated: false,
      },
      {
        workspace_id: wid,
        name: 'tj-actions/changed-files',
        publisher: 'tj-actions',
        pin_type: 'tag',
        pin_ref: 'v44',
        is_verified_publisher: false,
        inherited_privileges: ['contents:read', 'env:write'],
        risk_level: 'high',
        usage_count: 2,
        is_deprecated: false,
      },
      {
        workspace_id: wid,
        name: 'aws-actions/configure-aws-credentials',
        publisher: 'aws-actions',
        pin_type: 'branch',
        pin_ref: 'main',
        is_verified_publisher: true,
        inherited_privileges: ['id-token:write'],
        risk_level: 'medium',
        usage_count: 1,
        is_deprecated: false,
      },
    ])
    .returning()

  // --- Pipeline <-> Action links ------------------------------------------
  await db.insert(pipeline_actions).values([
    {
      workspace_id: wid,
      pipeline_id: deployPipeline.id,
      action_id: checkoutAction.id,
      step_name: 'Checkout',
      inherited_privileges: ['contents:read'],
    },
    {
      workspace_id: wid,
      pipeline_id: deployPipeline.id,
      action_id: awsCredsAction.id,
      step_name: 'Configure AWS',
      inherited_privileges: ['id-token:write'],
    },
    {
      workspace_id: wid,
      pipeline_id: testPipeline.id,
      action_id: changedFilesAction.id,
      step_name: 'Detect changes',
      inherited_privileges: ['contents:read', 'env:write'],
    },
  ])

  // --- Secrets -------------------------------------------------------------
  const [awsKeySecret, npmTokenSecret, slackSecret] = await db
    .insert(secrets)
    .values([
      {
        workspace_id: wid,
        name: 'AWS_ACCESS_KEY_ID',
        store: 'provider',
        is_scoped: false,
        is_masked: true,
        is_plaintext: false,
        exposed_to_fork_pr: false,
        last_rotated_at: iso(-200),
        rotation_age_days: 200,
      },
      {
        workspace_id: wid,
        name: 'NPM_TOKEN',
        store: 'plaintext',
        is_scoped: false,
        is_masked: false,
        is_plaintext: true,
        exposed_to_fork_pr: true,
        last_rotated_at: iso(-400),
        rotation_age_days: 400,
      },
      {
        workspace_id: wid,
        name: 'SLACK_WEBHOOK',
        store: 'vault',
        is_scoped: true,
        is_masked: true,
        is_plaintext: false,
        exposed_to_fork_pr: false,
        last_rotated_at: iso(-15),
        rotation_age_days: 15,
      },
    ])
    .returning()

  // --- Secret references ---------------------------------------------------
  await db.insert(secret_references).values([
    {
      workspace_id: wid,
      secret_id: awsKeySecret.id,
      pipeline_id: releasePipeline.id,
      usage_context: 'env',
      is_logged: false,
    },
    {
      workspace_id: wid,
      secret_id: npmTokenSecret.id,
      pipeline_id: testPipeline.id,
      usage_context: 'env',
      is_logged: true,
    },
    {
      workspace_id: wid,
      secret_id: slackSecret.id,
      pipeline_id: deployPipeline.id,
      usage_context: 'step',
      is_logged: false,
    },
  ])

  // --- Effective permissions ----------------------------------------------
  await db.insert(effective_permissions).values([
    {
      workspace_id: wid,
      pipeline_id: deployPipeline.id,
      action: 's3:PutObject',
      category: 'cloud',
      resource_id: s3Prod.id,
      source_chain: ['oidc:gha', 'role:ci-deploy-prod', 'policy:AmazonS3FullAccess'],
      is_excess: false,
    },
    {
      workspace_id: wid,
      pipeline_id: deployPipeline.id,
      action: 'ecr:*',
      category: 'registry',
      resource_id: ecrProd.id,
      source_chain: ['oidc:gha', 'role:ci-deploy-prod', 'policy:AmazonECRFullAccess'],
      is_excess: true,
    },
    {
      workspace_id: wid,
      pipeline_id: releasePipeline.id,
      action: '*',
      category: 'cloud',
      resource_id: dbProd.id,
      source_chain: ['static_key', 'role:ci-admin', 'policy:AdministratorAccess'],
      is_excess: true,
    },
  ])

  // --- Blast radius --------------------------------------------------------
  await db.insert(blast_radius).values([
    {
      workspace_id: wid,
      pipeline_id: deployPipeline.id,
      score: 78.0,
      reachable_resource_ids: [s3Prod.id, ecrProd.id],
      reachable_secret_ids: [slackSecret.id],
      reachable_pipeline_ids: [],
      crown_jewel_count: 2,
      summary: 'Reaches prod artifacts and ECR via ci-deploy-prod role.',
      computed_at: iso(-1),
    },
    {
      workspace_id: wid,
      pipeline_id: releasePipeline.id,
      score: 96.0,
      reachable_resource_ids: [s3Prod.id, ecrProd.id, dbProd.id],
      reachable_secret_ids: [awsKeySecret.id],
      reachable_pipeline_ids: [deployPipeline.id],
      crown_jewel_count: 3,
      summary: 'Admin role + long-lived key reaches all crown jewels and can trigger deploy.',
      computed_at: iso(-3),
    },
  ])

  // --- Attack paths --------------------------------------------------------
  await db.insert(attack_paths).values([
    {
      workspace_id: wid,
      pipeline_id: releasePipeline.id,
      from_node: 'release',
      from_kind: 'pipeline',
      to_node: 'ci-admin',
      to_kind: 'role',
      edge_type: 'assumes',
      weight: 1.0,
    },
    {
      workspace_id: wid,
      pipeline_id: releasePipeline.id,
      from_node: 'ci-admin',
      from_kind: 'role',
      to_node: 'prod-db-secrets',
      to_kind: 'resource',
      edge_type: 'reads',
      weight: 0.9,
    },
    {
      workspace_id: wid,
      pipeline_id: deployPipeline.id,
      from_node: 'deploy-prod',
      from_kind: 'pipeline',
      to_node: 'ci-deploy-prod',
      to_kind: 'role',
      edge_type: 'assumes',
      weight: 1.0,
    },
    {
      workspace_id: wid,
      pipeline_id: deployPipeline.id,
      from_node: 'ci-deploy-prod',
      from_kind: 'role',
      to_node: 'prod-artifacts',
      to_kind: 'resource',
      edge_type: 'writes',
      weight: 0.8,
    },
  ])

  // --- Findings ------------------------------------------------------------
  const [excessFinding, actionFinding, secretFinding, blastFinding] = await db
    .insert(findings)
    .values([
      {
        workspace_id: wid,
        pipeline_id: deployPipeline.id,
        detector: 'over_privilege',
        title: 'Wildcard ECR permission exceeds usage',
        description: 'ci-deploy-prod grants ecr:* but the pipeline only pushes images.',
        severity: 'high',
        status: 'open',
        evidence: { action: 'ecr:*', used: ['ecr:PutImage', 'ecr:GetAuthorizationToken'] },
        created_by: userId,
      },
      {
        workspace_id: wid,
        pipeline_id: testPipeline.id,
        detector: 'action_risk',
        title: 'Unpinned third-party action from unverified publisher',
        description: 'tj-actions/changed-files is pinned to a mutable tag (v44).',
        severity: 'high',
        status: 'open',
        evidence: { action: 'tj-actions/changed-files', pin_type: 'tag', pin_ref: 'v44' },
        created_by: userId,
      },
      {
        workspace_id: wid,
        pipeline_id: testPipeline.id,
        detector: 'secret',
        title: 'Plaintext secret exposed to fork PRs',
        description: 'NPM_TOKEN is plaintext, unmasked, logged, and exposed to fork PRs.',
        severity: 'critical',
        status: 'open',
        evidence: { secret: 'NPM_TOKEN', is_plaintext: true, exposed_to_fork_pr: true },
        created_by: userId,
      },
      {
        workspace_id: wid,
        pipeline_id: releasePipeline.id,
        detector: 'blast_radius',
        title: 'Pipeline reaches all crown-jewel resources',
        description: 'release uses a long-lived admin key reaching every crown jewel.',
        severity: 'critical',
        status: 'acknowledged',
        evidence: { score: 96, crown_jewels: 3 },
        assignee: 'platform@acme.example',
        created_by: userId,
      },
    ])
    .returning()

  // --- Recommendations -----------------------------------------------------
  await db.insert(recommendations).values([
    {
      workspace_id: wid,
      pipeline_id: deployPipeline.id,
      finding_id: excessFinding.id,
      kind: 'least_privilege',
      title: 'Scope ECR permission to required actions',
      detail: 'Replace ecr:* with ecr:PutImage, ecr:GetAuthorizationToken, ecr:BatchCheckLayerAvailability.',
      suggested_diff: '- ecr:*\n+ ecr:PutImage\n+ ecr:GetAuthorizationToken\n+ ecr:BatchCheckLayerAvailability',
      risk_delta: -22.0,
      status: 'open',
    },
    {
      workspace_id: wid,
      pipeline_id: testPipeline.id,
      finding_id: actionFinding.id,
      kind: 'pin_upgrade',
      title: 'Pin tj-actions/changed-files to a commit SHA',
      detail: 'Pin to an immutable SHA to defend against tag-hijack supply-chain attacks.',
      suggested_diff: '- uses: tj-actions/changed-files@v44\n+ uses: tj-actions/changed-files@<verified-sha>',
      risk_delta: -18.0,
      status: 'open',
    },
    {
      workspace_id: wid,
      pipeline_id: releasePipeline.id,
      finding_id: blastFinding.id,
      kind: 'trust_tighten',
      title: 'Replace long-lived key with branch-scoped OIDC',
      detail: 'Drop the static AWS key in favour of OIDC with a branch-scoped sub claim and least-privilege role.',
      suggested_diff: '- AWS_ACCESS_KEY_ID (static)\n+ OIDC trust sub: repo:acme/infra:ref:refs/heads/main',
      risk_delta: -40.0,
      status: 'open',
    },
  ])

  // --- Policies ------------------------------------------------------------
  const [pinPolicy, plaintextPolicy, oidcPolicy] = await db
    .insert(policies)
    .values([
      {
        workspace_id: wid,
        name: 'Actions must be pinned to SHA',
        rule_type: 'actions_pinned_sha',
        config: {},
        severity: 'high',
        is_enabled: true,
        created_by: userId,
      },
      {
        workspace_id: wid,
        name: 'No plaintext secrets',
        rule_type: 'no_plaintext_secret',
        config: {},
        severity: 'critical',
        is_enabled: true,
        created_by: userId,
      },
      {
        workspace_id: wid,
        name: 'OIDC trusts must be branch-scoped',
        rule_type: 'oidc_branch_scoped',
        config: {},
        severity: 'high',
        is_enabled: true,
        created_by: userId,
      },
    ])
    .returning()

  // --- Policy violations ---------------------------------------------------
  await db.insert(policy_violations).values([
    {
      workspace_id: wid,
      policy_id: pinPolicy.id,
      pipeline_id: testPipeline.id,
      status: 'open',
      detail: 'tj-actions/changed-files pinned to tag v44, not a SHA.',
    },
    {
      workspace_id: wid,
      policy_id: plaintextPolicy.id,
      pipeline_id: testPipeline.id,
      status: 'open',
      detail: 'NPM_TOKEN stored as plaintext.',
    },
    {
      workspace_id: wid,
      policy_id: oidcPolicy.id,
      pipeline_id: releasePipeline.id,
      status: 'open',
      detail: 'OIDC trust for acme/infra is not branch-scoped (repo:acme/infra:*).',
    },
  ])

  // --- Snapshots (with posture for risk-trend) -----------------------------
  const [baselineSnap, currentSnap] = await db
    .insert(snapshots)
    .values([
      {
        workspace_id: wid,
        label: 'Initial baseline',
        is_baseline: true,
        posture: { avg_risk_score: 55.0, finding_count: 2, critical: 0, high: 2 },
        pipeline_count: 3,
        finding_count: 2,
        created_by: userId,
      },
      {
        workspace_id: wid,
        label: 'Current posture',
        is_baseline: false,
        posture: { avg_risk_score: 73.8, finding_count: 4, critical: 2, high: 2 },
        pipeline_count: 3,
        finding_count: 4,
        created_by: userId,
      },
    ])
    .returning()

  // --- Drift events --------------------------------------------------------
  await db.insert(drift_events).values([
    {
      workspace_id: wid,
      pipeline_id: deployPipeline.id,
      from_snapshot_id: baselineSnap.id,
      to_snapshot_id: currentSnap.id,
      change_type: 'permission_added',
      before: { ecr: 'none' },
      after: { ecr: '*' },
      severity: 'high',
      status: 'open',
    },
    {
      workspace_id: wid,
      pipeline_id: releasePipeline.id,
      from_snapshot_id: baselineSnap.id,
      to_snapshot_id: currentSnap.id,
      change_type: 'identity_added',
      before: {},
      after: { identity: 'static AWS key' },
      severity: 'critical',
      status: 'open',
    },
  ])

  // --- Audits --------------------------------------------------------------
  await db.insert(audits).values([
    {
      workspace_id: wid,
      name: 'Weekly posture audit',
      schedule: 'weekly',
      status: 'completed',
      last_run_at: iso(-2),
      summary: { snapshots: 1, findings: 4, violations: 3 },
      created_by: userId,
    },
    {
      workspace_id: wid,
      name: 'Monthly SOC2 audit',
      schedule: 'monthly',
      status: 'idle',
      summary: {},
      created_by: userId,
    },
  ])

  // --- Evidence packs ------------------------------------------------------
  await db.insert(evidence_packs).values([
    {
      workspace_id: wid,
      framework: 'soc2',
      control: 'CC6.1',
      title: 'Logical access — least privilege',
      status: 'failing',
      contents: { findings: 1, excess_permissions: 2 },
      share_token: '',
      generated_at: iso(-1),
      created_by: userId,
    },
    {
      workspace_id: wid,
      framework: 'soc2',
      control: 'CC6.3',
      title: 'Credential management',
      status: 'failing',
      contents: { plaintext_secrets: 1, overdue_rotations: 2 },
      share_token: '',
      generated_at: iso(-1),
      created_by: userId,
    },
    {
      workspace_id: wid,
      framework: 'slsa',
      control: 'slsa_l3',
      title: 'Pinned, verified build dependencies',
      status: 'passing',
      contents: { pinned_actions: 1, unpinned_actions: 2 },
      share_token: '',
      generated_at: iso(-1),
      created_by: userId,
    },
  ])

  // --- Reports -------------------------------------------------------------
  await db.insert(reports).values([
    {
      workspace_id: wid,
      kind: 'exec_summary',
      title: 'Executive posture summary',
      content: { pipelines: 3, critical: 2, high: 2, avg_risk: 73.8 },
      format: 'markdown',
      created_by: userId,
    },
    {
      workspace_id: wid,
      kind: 'blast_radius',
      title: 'Blast-radius report — release',
      pipeline_id: releasePipeline.id,
      content: { score: 96, crown_jewels: 3 },
      format: 'markdown',
      created_by: userId,
    },
  ])

  // --- Alerts --------------------------------------------------------------
  await db.insert(alerts).values([
    {
      workspace_id: wid,
      name: 'New critical finding',
      trigger_type: 'new_critical_finding',
      threshold: { severity: 'critical' },
      is_enabled: true,
      created_by: userId,
    },
    {
      workspace_id: wid,
      name: 'Secret rotation overdue',
      trigger_type: 'secret_overdue',
      threshold: { max_age_days: 90 },
      is_enabled: true,
      created_by: userId,
    },
  ])

  // --- Notifications -------------------------------------------------------
  await db.insert(notifications).values([
    {
      workspace_id: wid,
      user_id: userId,
      title: 'Critical finding: plaintext secret exposed to fork PRs',
      body: 'NPM_TOKEN in acme-corp/web is plaintext and exposed to fork PRs.',
      severity: 'critical',
      is_read: false,
      link: '/dashboard/findings',
    },
    {
      workspace_id: wid,
      user_id: userId,
      title: 'Sample workspace seeded',
      body: 'A fully-populated demo workspace is ready to explore.',
      severity: 'info',
      is_read: false,
      link: '/dashboard',
    },
  ])

  // --- Activity log --------------------------------------------------------
  await db.insert(activity_log).values([
    {
      workspace_id: wid,
      actor_id: userId,
      action: 'seed_sample',
      entity_type: 'workspace',
      entity_id: wid,
      metadata: { source: 'seed/sample' },
    },
    {
      workspace_id: wid,
      actor_id: userId,
      action: 'scan_findings',
      entity_type: 'finding',
      entity_id: '',
      metadata: { created: 4 },
    },
  ])

  return c.json({ workspace_id: wid })
})

// ---------------------------------------------------------------------------
// DELETE /sample — tear down the header user's sample workspace.
// ---------------------------------------------------------------------------
router.delete('/sample', authMiddleware, async (c) => {
  const userId = getUserId(c)
  const slug = sampleSlug(userId)

  const [existing] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.slug, slug), eq(workspaces.owner_id, userId)))
  if (!existing) return c.json({ success: true, removed: false })

  await teardownSampleWorkspace(existing.id)
  return c.json({ success: true, removed: true })
})

export default router
