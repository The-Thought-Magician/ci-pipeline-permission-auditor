import { pgTable, text, integer, boolean, timestamp, jsonb, unique, real } from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Core tenancy
// ---------------------------------------------------------------------------

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  owner_id: text('owner_id').notNull(),
  description: text('description').default(''),
  severity_thresholds: jsonb('severity_thresholds').$type<Record<string, number>>().default({}),
  rotation_age_days: integer('rotation_age_days').default(90).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
})

export const teams = pgTable('teams', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  owner_email: text('owner_email').default(''),
  member_ids: jsonb('member_ids').$type<string[]>().default([]),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [unique().on(t.workspace_id, t.slug)])

// ---------------------------------------------------------------------------
// Providers / connections / ingestion
// ---------------------------------------------------------------------------

export const providers = pgTable('providers', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  kind: text('kind').notNull(), // github_actions | gitlab_ci | jenkins
  name: text('name').notNull(),
  base_url: text('base_url').default(''),
  org: text('org').default(''),
  status: text('status').default('connected').notNull(),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const connections = pgTable('connections', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  provider_id: text('provider_id').notNull().references(() => providers.id),
  label: text('label').notNull(),
  scope: text('scope').default('read').notNull(),
  status: text('status').default('idle').notNull(), // idle | syncing | error | ok
  last_synced_at: timestamp('last_synced_at'),
  last_error: text('last_error').default(''),
  config: jsonb('config').$type<Record<string, unknown>>().default({}),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Pipelines & identities
// ---------------------------------------------------------------------------

export const pipelines = pgTable('pipelines', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  provider_id: text('provider_id').notNull().references(() => providers.id),
  team_id: text('team_id').references(() => teams.id),
  name: text('name').notNull(),
  repo: text('repo').notNull(),
  branch: text('branch').default('main').notNull(),
  file_path: text('file_path').notNull(),
  triggers: jsonb('triggers').$type<string[]>().default([]),
  declared_permissions: jsonb('declared_permissions').$type<Record<string, string>>().default({}),
  raw_source: text('raw_source').default(''),
  risk_score: real('risk_score').default(0),
  last_seen_at: timestamp('last_seen_at'),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const pipeline_identities = pgTable('pipeline_identities', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  pipeline_id: text('pipeline_id').notNull().references(() => pipelines.id),
  identity_type: text('identity_type').notNull(), // github_token | oidc_role | service_account | stored_credential
  name: text('name').notNull(),
  credential_kind: text('credential_kind').default('').notNull(),
  is_long_lived: boolean('is_long_lived').default(false).notNull(),
  environment: text('environment').default(''),
  tags: jsonb('tags').$type<string[]>().default([]),
  last_active_at: timestamp('last_active_at'),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const oidc_trusts = pgTable('oidc_trusts', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  identity_id: text('identity_id').references(() => pipeline_identities.id),
  issuer: text('issuer').notNull(),
  audience: text('audience').notNull(),
  sub_claim_pattern: text('sub_claim_pattern').notNull(),
  is_branch_scoped: boolean('is_branch_scoped').default(false).notNull(),
  assumable_role_ids: jsonb('assumable_role_ids').$type<string[]>().default([]),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const roles = pgTable('roles', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  cloud: text('cloud').default('aws').notNull(), // aws | gcp | azure | other
  arn: text('arn').default(''),
  policy_summary: jsonb('policy_summary').$type<Record<string, unknown>>().default({}),
  is_privileged: boolean('is_privileged').default(false).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const permissions = pgTable('permissions', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  role_id: text('role_id').references(() => roles.id),
  identity_id: text('identity_id').references(() => pipeline_identities.id),
  resource_id: text('resource_id').references(() => resources.id),
  action: text('action').notNull(), // e.g. s3:GetObject, contents:write
  effect: text('effect').default('allow').notNull(), // allow | deny
  category: text('category').default('cloud').notNull(), // cloud | secret | registry | repo | deploy
  is_declared: boolean('is_declared').default(false).notNull(),
  is_wildcard: boolean('is_wildcard').default(false).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const resources = pgTable('resources', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  kind: text('kind').notNull(), // cloud | secret | registry | repo
  identifier: text('identifier').default(''),
  is_crown_jewel: boolean('is_crown_jewel').default(false).notNull(),
  environment: text('environment').default(''),
  tags: jsonb('tags').$type<string[]>().default([]),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Third-party Actions / plugins
// ---------------------------------------------------------------------------

export const actions = pgTable('actions', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(), // tj-actions/changed-files
  publisher: text('publisher').default('').notNull(),
  pin_type: text('pin_type').default('tag').notNull(), // tag | branch | sha
  pin_ref: text('pin_ref').default('').notNull(),
  is_verified_publisher: boolean('is_verified_publisher').default(false).notNull(),
  inherited_privileges: jsonb('inherited_privileges').$type<string[]>().default([]),
  risk_level: text('risk_level').default('low').notNull(),
  usage_count: integer('usage_count').default(0).notNull(),
  is_deprecated: boolean('is_deprecated').default(false).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [unique().on(t.workspace_id, t.name, t.pin_ref)])

export const pipeline_actions = pgTable('pipeline_actions', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  pipeline_id: text('pipeline_id').notNull().references(() => pipelines.id),
  action_id: text('action_id').notNull().references(() => actions.id),
  step_name: text('step_name').default(''),
  inherited_privileges: jsonb('inherited_privileges').$type<string[]>().default([]),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [unique().on(t.pipeline_id, t.action_id, t.step_name)])

// ---------------------------------------------------------------------------
// Secrets in CI
// ---------------------------------------------------------------------------

export const secrets = pgTable('secrets', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  store: text('store').default('provider').notNull(), // provider | vault | plaintext | env
  is_scoped: boolean('is_scoped').default(false).notNull(),
  is_masked: boolean('is_masked').default(true).notNull(),
  is_plaintext: boolean('is_plaintext').default(false).notNull(),
  exposed_to_fork_pr: boolean('exposed_to_fork_pr').default(false).notNull(),
  last_rotated_at: timestamp('last_rotated_at'),
  rotation_age_days: integer('rotation_age_days').default(0),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [unique().on(t.workspace_id, t.name)])

export const secret_references = pgTable('secret_references', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  secret_id: text('secret_id').notNull().references(() => secrets.id),
  pipeline_id: text('pipeline_id').notNull().references(() => pipelines.id),
  usage_context: text('usage_context').default('env').notNull(),
  is_logged: boolean('is_logged').default(false).notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [unique().on(t.secret_id, t.pipeline_id, t.usage_context)])

// ---------------------------------------------------------------------------
// Analysis results
// ---------------------------------------------------------------------------

export const effective_permissions = pgTable('effective_permissions', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  pipeline_id: text('pipeline_id').notNull().references(() => pipelines.id),
  action: text('action').notNull(),
  category: text('category').default('cloud').notNull(),
  resource_id: text('resource_id').references(() => resources.id),
  source_chain: jsonb('source_chain').$type<string[]>().default([]),
  is_excess: boolean('is_excess').default(false).notNull(),
  resolved_at: timestamp('resolved_at').defaultNow().notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const blast_radius = pgTable('blast_radius', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  pipeline_id: text('pipeline_id').notNull().references(() => pipelines.id),
  score: real('score').default(0).notNull(),
  reachable_resource_ids: jsonb('reachable_resource_ids').$type<string[]>().default([]),
  reachable_secret_ids: jsonb('reachable_secret_ids').$type<string[]>().default([]),
  reachable_pipeline_ids: jsonb('reachable_pipeline_ids').$type<string[]>().default([]),
  crown_jewel_count: integer('crown_jewel_count').default(0).notNull(),
  summary: text('summary').default(''),
  computed_at: timestamp('computed_at').defaultNow().notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const attack_paths = pgTable('attack_paths', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  pipeline_id: text('pipeline_id').notNull().references(() => pipelines.id),
  from_node: text('from_node').notNull(),
  from_kind: text('from_kind').notNull(), // pipeline | identity | role | resource | secret
  to_node: text('to_node').notNull(),
  to_kind: text('to_kind').notNull(),
  edge_type: text('edge_type').notNull(), // assumes | reads | writes | triggers
  weight: real('weight').default(1),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Findings / recommendations / policies
// ---------------------------------------------------------------------------

export const findings = pgTable('findings', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  pipeline_id: text('pipeline_id').references(() => pipelines.id),
  detector: text('detector').notNull(), // over_privilege | action_risk | secret | drift | blast_radius | policy
  title: text('title').notNull(),
  description: text('description').default(''),
  severity: text('severity').default('medium').notNull(), // critical | high | medium | low
  status: text('status').default('open').notNull(), // open | acknowledged | remediated | suppressed
  evidence: jsonb('evidence').$type<Record<string, unknown>>().default({}),
  assignee: text('assignee').default(''),
  due_date: timestamp('due_date'),
  suppress_reason: text('suppress_reason').default(''),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
})

export const recommendations = pgTable('recommendations', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  pipeline_id: text('pipeline_id').references(() => pipelines.id),
  finding_id: text('finding_id').references(() => findings.id),
  kind: text('kind').notNull(), // least_privilege | pin_upgrade | secret_rotation | trust_tighten
  title: text('title').notNull(),
  detail: text('detail').default(''),
  suggested_diff: text('suggested_diff').default(''),
  risk_delta: real('risk_delta').default(0),
  status: text('status').default('open').notNull(), // open | applied | dismissed
  applied_by: text('applied_by').default(''),
  applied_at: timestamp('applied_at'),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const policies = pgTable('policies', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  rule_type: text('rule_type').notNull(), // no_write_all | actions_pinned_sha | oidc_branch_scoped | secret_rotation_max_days | no_plaintext_secret
  config: jsonb('config').$type<Record<string, unknown>>().default({}),
  severity: text('severity').default('high').notNull(),
  is_enabled: boolean('is_enabled').default(true).notNull(),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const policy_violations = pgTable('policy_violations', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  policy_id: text('policy_id').notNull().references(() => policies.id),
  pipeline_id: text('pipeline_id').references(() => pipelines.id),
  status: text('status').default('open').notNull(), // open | exempted | resolved
  detail: text('detail').default(''),
  exemption_reason: text('exemption_reason').default(''),
  evaluated_at: timestamp('evaluated_at').defaultNow().notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Drift / snapshots / audits / evidence / reports
// ---------------------------------------------------------------------------

export const snapshots = pgTable('snapshots', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  label: text('label').notNull(),
  is_baseline: boolean('is_baseline').default(false).notNull(),
  posture: jsonb('posture').$type<Record<string, unknown>>().default({}),
  pipeline_count: integer('pipeline_count').default(0).notNull(),
  finding_count: integer('finding_count').default(0).notNull(),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const drift_events = pgTable('drift_events', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  pipeline_id: text('pipeline_id').references(() => pipelines.id),
  from_snapshot_id: text('from_snapshot_id').references(() => snapshots.id),
  to_snapshot_id: text('to_snapshot_id').references(() => snapshots.id),
  change_type: text('change_type').notNull(), // permission_added | permission_removed | identity_added | action_added | trust_changed
  before: jsonb('before').$type<Record<string, unknown>>().default({}),
  after: jsonb('after').$type<Record<string, unknown>>().default({}),
  severity: text('severity').default('medium').notNull(),
  status: text('status').default('open').notNull(), // open | approved | rejected
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const audits = pgTable('audits', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  schedule: text('schedule').default('manual').notNull(), // manual | daily | weekly | monthly
  status: text('status').default('idle').notNull(), // idle | running | completed | failed
  last_run_at: timestamp('last_run_at'),
  summary: jsonb('summary').$type<Record<string, unknown>>().default({}),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const evidence_packs = pgTable('evidence_packs', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  framework: text('framework').notNull(), // soc2 | slsa
  control: text('control').notNull(), // CC6.1 | CC6.3 | slsa_l3 ...
  title: text('title').notNull(),
  status: text('status').default('draft').notNull(), // draft | passing | failing
  contents: jsonb('contents').$type<Record<string, unknown>>().default({}),
  share_token: text('share_token').default(''),
  generated_at: timestamp('generated_at').defaultNow().notNull(),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const reports = pgTable('reports', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  kind: text('kind').notNull(), // exec_summary | pipeline_deep_dive | blast_radius | secret_hygiene
  title: text('title').notNull(),
  pipeline_id: text('pipeline_id').references(() => pipelines.id),
  content: jsonb('content').$type<Record<string, unknown>>().default({}),
  format: text('format').default('markdown').notNull(),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Alerts / notifications / activity
// ---------------------------------------------------------------------------

export const alerts = pgTable('alerts', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  trigger_type: text('trigger_type').notNull(), // new_critical_finding | drift_detected | secret_overdue
  threshold: jsonb('threshold').$type<Record<string, unknown>>().default({}),
  is_enabled: boolean('is_enabled').default(true).notNull(),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const notifications = pgTable('notifications', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  user_id: text('user_id').notNull(),
  title: text('title').notNull(),
  body: text('body').default(''),
  severity: text('severity').default('info').notNull(),
  is_read: boolean('is_read').default(false).notNull(),
  link: text('link').default(''),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const activity_log = pgTable('activity_log', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id),
  actor_id: text('actor_id').notNull(),
  action: text('action').notNull(),
  entity_type: text('entity_type').notNull(),
  entity_id: text('entity_id').default(''),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export const plans = pgTable('plans', {
  id: text('id').primaryKey(), // 'free' | 'pro'
  name: text('name').notNull(),
  price_cents: integer('price_cents').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
})

export const subscriptions = pgTable('subscriptions', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  user_id: text('user_id').notNull().unique(),
  plan_id: text('plan_id').notNull().default('free').references(() => plans.id),
  stripe_customer_id: text('stripe_customer_id'),
  stripe_subscription_id: text('stripe_subscription_id'),
  status: text('status').notNull().default('active'),
  current_period_end: timestamp('current_period_end'),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
})
