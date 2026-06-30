import { db } from './index.js'
import { sql } from 'drizzle-orm'

// Self-provisioning schema for a fresh Neon database.
// Every CREATE TABLE statement mirrors src/db/schema.ts EXACTLY
// (column names, types, PK, FK, UNIQUE). Timestamps use timestamptz,
// jsonb for json columns, real for floats. All statements are idempotent.

const statements: string[] = [
  // --- workspaces ---
  `CREATE TABLE IF NOT EXISTS workspaces (
    id text PRIMARY KEY,
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    owner_id text NOT NULL,
    description text DEFAULT '',
    severity_thresholds jsonb DEFAULT '{}'::jsonb,
    rotation_age_days integer DEFAULT 90 NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- teams ---
  `CREATE TABLE IF NOT EXISTS teams (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    name text NOT NULL,
    slug text NOT NULL,
    owner_email text DEFAULT '',
    member_ids jsonb DEFAULT '[]'::jsonb,
    created_by text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    UNIQUE (workspace_id, slug)
  )`,

  // --- providers ---
  `CREATE TABLE IF NOT EXISTS providers (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    kind text NOT NULL,
    name text NOT NULL,
    base_url text DEFAULT '',
    org text DEFAULT '',
    status text DEFAULT 'connected' NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- connections ---
  `CREATE TABLE IF NOT EXISTS connections (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    provider_id text NOT NULL REFERENCES providers(id),
    label text NOT NULL,
    scope text DEFAULT 'read' NOT NULL,
    status text DEFAULT 'idle' NOT NULL,
    last_synced_at timestamptz,
    last_error text DEFAULT '',
    config jsonb DEFAULT '{}'::jsonb,
    created_by text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- resources (created before permissions which FK to it) ---
  `CREATE TABLE IF NOT EXISTS resources (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    name text NOT NULL,
    kind text NOT NULL,
    identifier text DEFAULT '',
    is_crown_jewel boolean DEFAULT false NOT NULL,
    environment text DEFAULT '',
    tags jsonb DEFAULT '[]'::jsonb,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- pipelines ---
  `CREATE TABLE IF NOT EXISTS pipelines (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    provider_id text NOT NULL REFERENCES providers(id),
    team_id text REFERENCES teams(id),
    name text NOT NULL,
    repo text NOT NULL,
    branch text DEFAULT 'main' NOT NULL,
    file_path text NOT NULL,
    triggers jsonb DEFAULT '[]'::jsonb,
    declared_permissions jsonb DEFAULT '{}'::jsonb,
    raw_source text DEFAULT '',
    risk_score real DEFAULT 0,
    last_seen_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- pipeline_identities ---
  `CREATE TABLE IF NOT EXISTS pipeline_identities (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    pipeline_id text NOT NULL REFERENCES pipelines(id),
    identity_type text NOT NULL,
    name text NOT NULL,
    credential_kind text DEFAULT '' NOT NULL,
    is_long_lived boolean DEFAULT false NOT NULL,
    environment text DEFAULT '',
    tags jsonb DEFAULT '[]'::jsonb,
    last_active_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- oidc_trusts ---
  `CREATE TABLE IF NOT EXISTS oidc_trusts (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    identity_id text REFERENCES pipeline_identities(id),
    issuer text NOT NULL,
    audience text NOT NULL,
    sub_claim_pattern text NOT NULL,
    is_branch_scoped boolean DEFAULT false NOT NULL,
    assumable_role_ids jsonb DEFAULT '[]'::jsonb,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- roles ---
  `CREATE TABLE IF NOT EXISTS roles (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    name text NOT NULL,
    cloud text DEFAULT 'aws' NOT NULL,
    arn text DEFAULT '',
    policy_summary jsonb DEFAULT '{}'::jsonb,
    is_privileged boolean DEFAULT false NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- permissions ---
  `CREATE TABLE IF NOT EXISTS permissions (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    role_id text REFERENCES roles(id),
    identity_id text REFERENCES pipeline_identities(id),
    resource_id text REFERENCES resources(id),
    action text NOT NULL,
    effect text DEFAULT 'allow' NOT NULL,
    category text DEFAULT 'cloud' NOT NULL,
    is_declared boolean DEFAULT false NOT NULL,
    is_wildcard boolean DEFAULT false NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- actions ---
  `CREATE TABLE IF NOT EXISTS actions (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    name text NOT NULL,
    publisher text DEFAULT '' NOT NULL,
    pin_type text DEFAULT 'tag' NOT NULL,
    pin_ref text DEFAULT '' NOT NULL,
    is_verified_publisher boolean DEFAULT false NOT NULL,
    inherited_privileges jsonb DEFAULT '[]'::jsonb,
    risk_level text DEFAULT 'low' NOT NULL,
    usage_count integer DEFAULT 0 NOT NULL,
    is_deprecated boolean DEFAULT false NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    UNIQUE (workspace_id, name, pin_ref)
  )`,

  // --- pipeline_actions ---
  `CREATE TABLE IF NOT EXISTS pipeline_actions (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    pipeline_id text NOT NULL REFERENCES pipelines(id),
    action_id text NOT NULL REFERENCES actions(id),
    step_name text DEFAULT '',
    inherited_privileges jsonb DEFAULT '[]'::jsonb,
    created_at timestamptz DEFAULT now() NOT NULL,
    UNIQUE (pipeline_id, action_id, step_name)
  )`,

  // --- secrets ---
  `CREATE TABLE IF NOT EXISTS secrets (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    name text NOT NULL,
    store text DEFAULT 'provider' NOT NULL,
    is_scoped boolean DEFAULT false NOT NULL,
    is_masked boolean DEFAULT true NOT NULL,
    is_plaintext boolean DEFAULT false NOT NULL,
    exposed_to_fork_pr boolean DEFAULT false NOT NULL,
    last_rotated_at timestamptz,
    rotation_age_days integer DEFAULT 0,
    created_at timestamptz DEFAULT now() NOT NULL,
    UNIQUE (workspace_id, name)
  )`,

  // --- secret_references ---
  `CREATE TABLE IF NOT EXISTS secret_references (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    secret_id text NOT NULL REFERENCES secrets(id),
    pipeline_id text NOT NULL REFERENCES pipelines(id),
    usage_context text DEFAULT 'env' NOT NULL,
    is_logged boolean DEFAULT false NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    UNIQUE (secret_id, pipeline_id, usage_context)
  )`,

  // --- effective_permissions ---
  `CREATE TABLE IF NOT EXISTS effective_permissions (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    pipeline_id text NOT NULL REFERENCES pipelines(id),
    action text NOT NULL,
    category text DEFAULT 'cloud' NOT NULL,
    resource_id text REFERENCES resources(id),
    source_chain jsonb DEFAULT '[]'::jsonb,
    is_excess boolean DEFAULT false NOT NULL,
    resolved_at timestamptz DEFAULT now() NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- blast_radius ---
  `CREATE TABLE IF NOT EXISTS blast_radius (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    pipeline_id text NOT NULL REFERENCES pipelines(id),
    score real DEFAULT 0 NOT NULL,
    reachable_resource_ids jsonb DEFAULT '[]'::jsonb,
    reachable_secret_ids jsonb DEFAULT '[]'::jsonb,
    reachable_pipeline_ids jsonb DEFAULT '[]'::jsonb,
    crown_jewel_count integer DEFAULT 0 NOT NULL,
    summary text DEFAULT '',
    computed_at timestamptz DEFAULT now() NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- attack_paths ---
  `CREATE TABLE IF NOT EXISTS attack_paths (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    pipeline_id text NOT NULL REFERENCES pipelines(id),
    from_node text NOT NULL,
    from_kind text NOT NULL,
    to_node text NOT NULL,
    to_kind text NOT NULL,
    edge_type text NOT NULL,
    weight real DEFAULT 1,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- findings ---
  `CREATE TABLE IF NOT EXISTS findings (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    pipeline_id text REFERENCES pipelines(id),
    detector text NOT NULL,
    title text NOT NULL,
    description text DEFAULT '',
    severity text DEFAULT 'medium' NOT NULL,
    status text DEFAULT 'open' NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb,
    assignee text DEFAULT '',
    due_date timestamptz,
    suppress_reason text DEFAULT '',
    created_by text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- recommendations ---
  `CREATE TABLE IF NOT EXISTS recommendations (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    pipeline_id text REFERENCES pipelines(id),
    finding_id text REFERENCES findings(id),
    kind text NOT NULL,
    title text NOT NULL,
    detail text DEFAULT '',
    suggested_diff text DEFAULT '',
    risk_delta real DEFAULT 0,
    status text DEFAULT 'open' NOT NULL,
    applied_by text DEFAULT '',
    applied_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- policies ---
  `CREATE TABLE IF NOT EXISTS policies (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    name text NOT NULL,
    rule_type text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb,
    severity text DEFAULT 'high' NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- policy_violations ---
  `CREATE TABLE IF NOT EXISTS policy_violations (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    policy_id text NOT NULL REFERENCES policies(id),
    pipeline_id text REFERENCES pipelines(id),
    status text DEFAULT 'open' NOT NULL,
    detail text DEFAULT '',
    exemption_reason text DEFAULT '',
    evaluated_at timestamptz DEFAULT now() NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- snapshots ---
  `CREATE TABLE IF NOT EXISTS snapshots (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    label text NOT NULL,
    is_baseline boolean DEFAULT false NOT NULL,
    posture jsonb DEFAULT '{}'::jsonb,
    pipeline_count integer DEFAULT 0 NOT NULL,
    finding_count integer DEFAULT 0 NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- drift_events ---
  `CREATE TABLE IF NOT EXISTS drift_events (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    pipeline_id text REFERENCES pipelines(id),
    from_snapshot_id text REFERENCES snapshots(id),
    to_snapshot_id text REFERENCES snapshots(id),
    change_type text NOT NULL,
    before jsonb DEFAULT '{}'::jsonb,
    after jsonb DEFAULT '{}'::jsonb,
    severity text DEFAULT 'medium' NOT NULL,
    status text DEFAULT 'open' NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- audits ---
  `CREATE TABLE IF NOT EXISTS audits (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    name text NOT NULL,
    schedule text DEFAULT 'manual' NOT NULL,
    status text DEFAULT 'idle' NOT NULL,
    last_run_at timestamptz,
    summary jsonb DEFAULT '{}'::jsonb,
    created_by text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- evidence_packs ---
  `CREATE TABLE IF NOT EXISTS evidence_packs (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    framework text NOT NULL,
    control text NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'draft' NOT NULL,
    contents jsonb DEFAULT '{}'::jsonb,
    share_token text DEFAULT '',
    generated_at timestamptz DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- reports ---
  `CREATE TABLE IF NOT EXISTS reports (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    kind text NOT NULL,
    title text NOT NULL,
    pipeline_id text REFERENCES pipelines(id),
    content jsonb DEFAULT '{}'::jsonb,
    format text DEFAULT 'markdown' NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- alerts ---
  `CREATE TABLE IF NOT EXISTS alerts (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    name text NOT NULL,
    trigger_type text NOT NULL,
    threshold jsonb DEFAULT '{}'::jsonb,
    is_enabled boolean DEFAULT true NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- notifications ---
  `CREATE TABLE IF NOT EXISTS notifications (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    user_id text NOT NULL,
    title text NOT NULL,
    body text DEFAULT '',
    severity text DEFAULT 'info' NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    link text DEFAULT '',
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- activity_log ---
  `CREATE TABLE IF NOT EXISTS activity_log (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES workspaces(id),
    actor_id text NOT NULL,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text DEFAULT '',
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- plans ---
  `CREATE TABLE IF NOT EXISTS plans (
    id text PRIMARY KEY,
    name text NOT NULL,
    price_cents integer NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
  )`,

  // --- subscriptions ---
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id text PRIMARY KEY,
    user_id text NOT NULL UNIQUE,
    plan_id text NOT NULL DEFAULT 'free' REFERENCES plans(id),
    stripe_customer_id text,
    stripe_subscription_id text,
    status text NOT NULL DEFAULT 'active',
    current_period_end timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
  )`,
]

const indexes: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_teams_workspace ON teams (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_providers_workspace ON providers (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_connections_workspace ON connections (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_connections_provider ON connections (provider_id)`,
  `CREATE INDEX IF NOT EXISTS idx_resources_workspace ON resources (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pipelines_workspace ON pipelines (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pipelines_provider ON pipelines (provider_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pipelines_team ON pipelines (team_id)`,
  `CREATE INDEX IF NOT EXISTS idx_identities_workspace ON pipeline_identities (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_identities_pipeline ON pipeline_identities (pipeline_id)`,
  `CREATE INDEX IF NOT EXISTS idx_oidc_workspace ON oidc_trusts (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_oidc_identity ON oidc_trusts (identity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_roles_workspace ON roles (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_permissions_workspace ON permissions (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_permissions_role ON permissions (role_id)`,
  `CREATE INDEX IF NOT EXISTS idx_permissions_identity ON permissions (identity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions (resource_id)`,
  `CREATE INDEX IF NOT EXISTS idx_actions_workspace ON actions (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_actions_workspace ON pipeline_actions (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_actions_pipeline ON pipeline_actions (pipeline_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_actions_action ON pipeline_actions (action_id)`,
  `CREATE INDEX IF NOT EXISTS idx_secrets_workspace ON secrets (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_secret_refs_workspace ON secret_references (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_secret_refs_secret ON secret_references (secret_id)`,
  `CREATE INDEX IF NOT EXISTS idx_secret_refs_pipeline ON secret_references (pipeline_id)`,
  `CREATE INDEX IF NOT EXISTS idx_effective_workspace ON effective_permissions (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_effective_pipeline ON effective_permissions (pipeline_id)`,
  `CREATE INDEX IF NOT EXISTS idx_blast_workspace ON blast_radius (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_blast_pipeline ON blast_radius (pipeline_id)`,
  `CREATE INDEX IF NOT EXISTS idx_attack_workspace ON attack_paths (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_attack_pipeline ON attack_paths (pipeline_id)`,
  `CREATE INDEX IF NOT EXISTS idx_findings_workspace ON findings (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_findings_pipeline ON findings (pipeline_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recommendations_workspace ON recommendations (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recommendations_pipeline ON recommendations (pipeline_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recommendations_finding ON recommendations (finding_id)`,
  `CREATE INDEX IF NOT EXISTS idx_policies_workspace ON policies (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_violations_workspace ON policy_violations (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_violations_policy ON policy_violations (policy_id)`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_workspace ON snapshots (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_drift_workspace ON drift_events (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_drift_pipeline ON drift_events (pipeline_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audits_workspace ON audits (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_workspace ON evidence_packs (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_workspace ON reports (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_workspace ON alerts (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_workspace ON notifications (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_workspace ON activity_log (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions (user_id)`,
]

export async function migrate() {
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt))
  }
  for (const idx of indexes) {
    await db.execute(sql.raw(idx))
  }
  console.log('Migration complete: tables and indexes provisioned')
}
