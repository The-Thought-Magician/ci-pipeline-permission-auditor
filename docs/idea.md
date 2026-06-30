# CiPipelinePermissionAuditor

> Audit what your CI/CD pipelines and build bots can actually do, and surface the over-privileged automation that turns one poisoned workflow into a full breach.

---

## 1. Overview

CiPipelinePermissionAuditor (CPPA) is a continuous least-privilege audit platform scoped to **CI/CD machine identities** and the **pipeline-poisoning attack class**. It ingests pipeline definitions (GitHub Actions workflows, GitLab CI files, Jenkinsfiles), the OIDC trust and token configuration that backs them, and the third-party Actions/plugins they pull in, then computes an **effective-permission map**: for every pipeline, exactly what cloud resources, secrets, registries, and repos it can reach if it (or any step it runs) is compromised.

On top of that map CPPA runs a deterministic analysis engine that:

- inventories every pipeline identity and its assumable permissions,
- resolves the *effective* (transitive, inherited) privilege of each pipeline,
- flags over-privileged tokens and recommends a minimal least-privilege replacement,
- maps the risk inherited from third-party Actions/plugins,
- computes the blast radius of a poisoned workflow,
- tracks every secret referenced in CI (scoped? masked? rotated?),
- detects drift in pipeline permissions over time, and
- exports SOC2 / SLSA audit evidence packs.

Everything is **deterministic** (no opaque ML scoring) so findings are reproducible and defensible in an audit. The product ships with a built-in **sample-data seeder** so a signed-in user sees a fully populated org on first login. All analysis features are **free** for signed-in users; Stripe billing is optional and returns 503 when unconfigured.

---

## 2. Problem

Modern engineering orgs run hundreds of CI/CD pipelines. Each pipeline runs as a **machine identity** with credentials, OIDC trust relationships, and the ability to assume cloud roles, read secrets, push to registries, and write to repos. The recent wave of supply-chain incidents (Codecov bash uploader, the `tj-actions/changed-files` compromise, repeated GitHub Actions token-scope abuses) all share one root cause: **a single poisoned workflow step inherits far more privilege than the job actually needs, and one compromise reaches cloud accounts and secrets.**

Concretely:

- **No effective-privilege map.** Teams know what a role *grants* but not what a *pipeline* can actually reach once you follow OIDC trust + assumed roles + inherited Action permissions.
- **Over-broad `GITHUB_TOKEN` / CI tokens.** Default `permissions: write-all`, long-lived PATs, unscoped OIDC `sub` claims.
- **Opaque third-party Actions.** A pinned-by-tag Action can be swapped under you; its transitive privilege is invisible.
- **Blast radius is unmodeled.** When a workflow is poisoned, nobody can answer "what could the attacker reach?" in audit-grade terms.
- **Secrets in CI are unaccounted.** Which secrets does each pipeline reference? Are they masked in logs? Scoped to an environment? Ever rotated?
- **Permission drift is silent.** Permissions creep up over weeks; no one diffs the posture.
- **Audit evidence is manual.** SOC2 CC6.x least-privilege and SLSA build-integrity controls demand evidence that is assembled by hand the week before the audit.

The problem is **continuous** (pipelines change every day) and **spikes pre-audit**. The ROI is concrete: contain blast radius and satisfy least-privilege audit controls with deterministic, exportable evidence.

---

## 3. Target Users

- **DevSecOps / platform-security leads** at 100-1500 person orgs running GitHub Actions, GitLab CI, or Jenkins at scale.
- **AppSec leads** responsible for SLSA build-integrity and software-supply-chain posture.
- **Compliance / GRC owners** who need SOC2 CC6.1/CC6.3 (least-privilege) and SLSA evidence on demand.

**Buyer:** a DevSecOps / platform-security or AppSec lead with security-tooling budget and least-privilege / SLSA / SOC2 responsibility.

---

## 4. Why This Is NOT an Existing Project

CPPA is deliberately scoped to **CI machine identities and the pipeline-poisoning attack surface**. Near-neighbors and how CPPA differs:

- **iam-permissions-analyzer** (general/human IAM): analyzes human and general IAM permissions. CPPA only models **machine/pipeline** identities and the OIDC-trust + assumed-role + inherited-Action chain specific to build automation. It does not try to be a general IAM tool.
- **ci-pipeline-optimizer** (performance): optimizes pipeline *speed/cost*. CPPA is a *security/least-privilege* tool; it never touches performance.
- **permission-creep-auditor** (longitudinal human access): tracks human access creep over time. CPPA tracks **pipeline permission drift**, a different identity class and a different attack model.
- **dependency-update-risk-grader**: grades the *risk of applying an update*. CPPA grades the *standing privilege of automation* regardless of updates.
- **secret-exposure-blast-radius**: responds to *already-leaked secrets*. CPPA models the *latent* blast radius of a *poisoned pipeline* before any leak, and tracks secret *hygiene in CI* (scoped/masked/rotated) rather than incident response to leaks.

The ownable wedge: a **deterministic least-privilege audit-and-evidence** engine for CI machine identities and the poisoned-pipeline blast radius. No competitor combines effective-permission resolution for pipelines + poisoned-pipeline blast radius + third-party Action privilege inheritance + SLSA/SOC2 evidence export in one deterministic product.

---

## 5. Major Features

Each major feature below expands the flagship list into a full capability set.

### 5.1 Pipeline Identity Inventory
- Register **providers** (GitHub Actions, GitLab CI, Jenkins) per workspace.
- Discover **pipelines** (workflows / `.gitlab-ci.yml` / Jenkinsfiles) under each provider with repo, branch, file path, and trigger events.
- Each pipeline has one or more **pipeline identities** (the machine identity it runs as): `GITHUB_TOKEN`, an OIDC-assumed cloud role, a service account, or a stored credential.
- Catalog **OIDC trust configs**: issuer, audience, `sub` claim pattern, and which cloud roles each pattern is allowed to assume.
- Track **assumable permissions**: the concrete cloud permissions reachable via each identity.
- Sub-features: identity type classification, last-seen activity, owning team, environment scoping, identity tags.

### 5.2 Effective-Permission Resolver
- Compute, per pipeline, the **transitive set of effective permissions** by following: pipeline identity → OIDC trust → assumed roles → attached policies → inherited Action permissions.
- Resolve **permission sources** so every effective permission is attributable to a chain (explainability).
- Distinguish **declared** vs **effective** privilege (declared = what the workflow asks for; effective = what it can actually reach).
- Sub-features: per-resource grouping (cloud / secrets / registry / repo / deploy), wildcard expansion, deny-override handling, resolver run history.

### 5.3 Over-Privilege Detector
- Compare effective permissions against **observed/declared need** to flag unused or excess grants.
- Severity scoring (deterministic rubric): critical / high / medium / low.
- **Least-privilege recommendations**: a minimal permission set + the exact YAML/policy diff to apply it.
- Findings lifecycle: open → acknowledged → remediated → suppressed (with reason + expiry).
- Sub-features: per-finding evidence, recommended `permissions:` block, recommended trust-policy `sub` tightening, bulk acknowledge.

### 5.4 Third-Party Action / Plugin Risk Map
- Catalog every **third-party Action / GitLab include / Jenkins plugin** used across pipelines.
- For each, record pin type (tag / branch / SHA), publisher, popularity, and **inherited privileges** (what the host pipeline grants it).
- Risk grading: unpinned tag, mutable ref, excessive inherited privilege, unknown publisher.
- **Pin recommendations** (move tag → SHA) and allow-list policy.
- Sub-features: usage count per Action, affected-pipeline list, transitive-Action detection, deprecation flags.

### 5.5 Poisoned-Pipeline Blast Radius
- For any pipeline, compute the **blast radius**: the full set of cloud resources, secrets, registries, repos, and downstream pipelines an attacker reaches if that pipeline is poisoned.
- **Attack-path graph**: nodes (pipeline, identity, role, resource, secret) and edges (assumes, reads, writes, triggers).
- Blast-radius scoring + ranked "crown-jewel" reachability.
- **What-if simulation**: re-score after a proposed permission change.
- Sub-features: path explanation, lateral-movement detection (pipeline → pipeline), reachable-secret list, exportable graph.

### 5.6 Secret-Exposure-in-CI Tracker
- Inventory every **secret reference** in CI (env vars, secret stores, masked outputs).
- For each secret: **scoped?** (env/branch restricted), **masked?** (in logs), **rotated?** (last rotation, age).
- Detect plaintext secrets, secrets exposed to PRs from forks, secrets reachable by over-privileged pipelines.
- **Rotation tracker** with age thresholds and overdue alerts.
- Sub-features: secret-to-pipeline reachability, masking-gap findings, fork-PR exposure findings, rotation history log.

### 5.7 Drift Detection
- Periodic **snapshots** of pipeline permission posture.
- **Diff** between snapshots: permissions added/removed, new identities, new Actions, trust changes.
- **Drift findings** with before/after and severity.
- Baseline pinning ("this is approved posture") and drift-from-baseline alerts.
- Sub-features: snapshot scheduling, per-pipeline drift timeline, approve/reject drift, drift digest.

### 5.8 SOC2 / SLSA Audit-Evidence Export
- **Evidence packs** mapped to controls (SOC2 CC6.1/CC6.3 least-privilege, SLSA build-integrity levels).
- Each pack bundles: identity inventory, effective-permission map, open/closed findings, secret hygiene, drift history, and remediation log.
- Export to JSON / Markdown / CSV.
- **Control coverage view**: which controls have passing evidence.
- Sub-features: point-in-time export, auditor share link, evidence freshness, control mapping editor.

### 5.9 Findings & Remediation Workspace
- Unified **findings** list across all detectors (over-privilege, Action risk, secret, drift, blast-radius).
- Status workflow, assignee, due date, comments.
- **Remediation log**: who fixed what, when, with the applied diff.
- Saved filters and severity rollups.

### 5.10 Policy Engine (Guardrails)
- Author **policies** (deterministic rules): e.g. "no `permissions: write-all`", "all Actions pinned to SHA", "OIDC `sub` must be branch-scoped", "secrets must rotate < 90 days".
- Evaluate policies against current posture → **violations**.
- Policy enablement, severity, and exemption management.
- Sub-features: rule templates, per-pipeline policy results, policy pass-rate.

### 5.11 Pipeline Risk Scoring & Posture Dashboard
- Composite, deterministic **risk score** per pipeline and per workspace.
- Posture dashboard: trend, top-risk pipelines, finding mix, control coverage.
- Score breakdown (which factors drove it).

### 5.12 Resource & Crown-Jewel Catalog
- Catalog **cloud resources / secrets / registries / repos** referenced as permission targets.
- Mark **crown jewels** (production DB, prod cloud account, signing keys).
- Crown-jewel reachability report (which pipelines can reach them).

### 5.13 Provider Connections & Ingestion
- Configure **connections** to providers (token/URL, scope).
- **Ingestion runs**: upload workflow files or trigger a (simulated/deterministic) sync; parse into pipelines + identities + Actions + secrets.
- Ingestion status, parse errors, last-sync time.

### 5.14 Workflow File Parser & Analyzer
- Parse uploaded **workflow YAML / Jenkinsfile** text into a normalized model (jobs, steps, `permissions:`, `uses:`, `env`, secret refs).
- Inline analysis of a pasted workflow (no persistence) for quick checks.

### 5.15 Recommendations Center
- Aggregate all **actionable recommendations** (least-privilege diffs, pin upgrades, secret rotations, trust tightening).
- One-click "mark applied" with evidence capture.
- Recommendation impact estimate (risk-score delta).

### 5.16 Teams & Ownership
- **Teams** own pipelines; per-team posture and findings.
- Ownership assignment and team risk leaderboard.

### 5.17 Alerts & Notifications
- **Alert rules** (new critical finding, drift detected, secret overdue).
- In-app notifications feed, mark-read.

### 5.18 Scheduled Audits / Snapshots
- Schedule recurring **audits** (snapshot + policy eval + finding refresh).
- Audit history and per-audit summary.

### 5.19 Reports
- Generated **reports**: executive posture summary, per-pipeline deep-dive, blast-radius report, secret-hygiene report.
- Export and share.

### 5.20 Activity / Audit Log
- Immutable **activity log** of every change (who connected a provider, changed a policy, remediated a finding).
- Filterable by actor, entity, action.

### 5.21 Settings & Workspace
- Workspace settings, member management (via teams), tags taxonomy, severity thresholds, rotation-age thresholds.

### 5.22 Billing (Optional)
- Free for all signed-in users; Stripe-optional plan view; checkout/portal/webhook return 503 when unconfigured.

---

## 6. Data Model (tables)

- `workspaces` — top-level tenant (owner = user).
- `providers` — CI provider connection (github_actions / gitlab_ci / jenkins) per workspace.
- `connections` — credential/config + sync state for a provider.
- `pipelines` — a workflow/job definition (repo, file path, triggers).
- `pipeline_identities` — machine identity a pipeline runs as.
- `oidc_trusts` — OIDC issuer/audience/sub-claim trust configs.
- `roles` — cloud roles assumable by identities.
- `permissions` — atomic permissions attached to roles/identities (effective + declared).
- `resources` — permission targets (cloud/secret/registry/repo), crown-jewel flag.
- `actions` — third-party Actions/plugins catalog with pin/publisher/risk.
- `pipeline_actions` — join: which pipeline uses which action (inherited privilege).
- `secrets` — secret references in CI (scoped/masked/rotated).
- `secret_references` — join: pipeline ↔ secret usage context.
- `effective_permissions` — resolved transitive permission set per pipeline w/ source chain.
- `blast_radius` — computed blast-radius result per pipeline.
- `attack_paths` — edges in the attack-path graph.
- `findings` — unified findings across detectors.
- `recommendations` — actionable remediation suggestions.
- `policies` — guardrail rules.
- `policy_violations` — policy evaluation results.
- `snapshots` — posture snapshots for drift.
- `drift_events` — diffs between snapshots.
- `audits` — scheduled/run audits.
- `evidence_packs` — SOC2/SLSA evidence bundles.
- `reports` — generated reports.
- `teams` — ownership groups.
- `alerts` — alert rules.
- `notifications` — per-user notifications.
- `activity_log` — immutable change log.
- `plans` — billing plans (free/pro).
- `subscriptions` — per-user subscription.

---

## 7. API Surface (high level)

Mounted under `/api/v1`. Domain route files (each `export default router`):

`workspaces`, `providers`, `connections`, `pipelines`, `identities`, `oidc`, `roles`, `permissions`, `resources`, `actions`, `secrets`, `effective`, `blast-radius`, `attack-paths`, `findings`, `recommendations`, `policies`, `snapshots`, `drift`, `audits`, `evidence`, `reports`, `teams`, `alerts`, `notifications`, `activity`, `analyzer`, `stats`, `billing`, `seed`.

Pattern: public reads (`GET`), auth-gated writes (`POST/PUT/DELETE`) with zod validation + ownership checks via `getUserId(c)`.

---

## 8. Frontend Pages (~24)

Public:
1. `/` — landing (static).
2. `/auth/sign-in`
3. `/auth/sign-up`
4. `/pricing`

Dashboard (`/dashboard/*`, shared sidebar):
5. `/dashboard` — posture overview.
6. `/dashboard/pipelines` — pipeline inventory.
7. `/dashboard/pipelines/[id]` — pipeline detail (effective perms, blast radius).
8. `/dashboard/identities` — identity inventory + OIDC trusts.
9. `/dashboard/effective` — effective-permission explorer.
10. `/dashboard/over-privilege` — over-privilege findings.
11. `/dashboard/actions` — third-party Action risk map.
12. `/dashboard/blast-radius` — blast-radius explorer + graph.
13. `/dashboard/secrets` — secret-in-CI tracker.
14. `/dashboard/drift` — drift detection timeline.
15. `/dashboard/evidence` — SOC2/SLSA evidence packs.
16. `/dashboard/findings` — unified findings workspace.
17. `/dashboard/recommendations` — recommendations center.
18. `/dashboard/policies` — policy engine.
19. `/dashboard/resources` — resource & crown-jewel catalog.
20. `/dashboard/providers` — provider connections & ingestion.
21. `/dashboard/analyzer` — paste-a-workflow analyzer.
22. `/dashboard/audits` — scheduled audits.
23. `/dashboard/reports` — reports.
24. `/dashboard/teams` — teams & ownership.
25. `/dashboard/alerts` — alerts & notifications.
26. `/dashboard/activity` — activity log.
27. `/dashboard/settings` — settings.
