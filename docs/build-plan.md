# CiPipelinePermissionAuditor — Authoritative Build Contract

> This document is the SINGLE SOURCE OF TRUTH. Filenames, mount paths, api method names, and page files declared here are BINDING. Every other agent follows this exactly.
>
> Stack (from `_template-report.md`): Hono 4.12.27 + `@hono/node-server` 2.0.6 + drizzle-orm 0.45.2 + `@neondatabase/serverless` 1.1.0 backend; Next.js ^16.2.9 / React ^19.1.0 / Tailwind ^4.1.8 frontend; auth `@neondatabase/auth` 0.4.2-beta. Backend trusts `X-User-Id`, uses `getUserId(c)`; routes mount under `/api/v1` via a child Hono `api` router; web uses `proxy.ts` only; frontend calls `fetch('/api/proxy/<path>')` mapping 1:1 to `/api/v1/<path>`.

---

## A. Conventions (binding)

- Every domain route file lives at `backend/src/routes/<file>.ts` and `export default router`.
- Mounted in `backend/src/index.ts` as `api.route('/<mount>', <import>)`, then `app.route('/api/v1', api)`.
- Public reads (`GET`) require no auth. Writes (`POST/PUT/PATCH/DELETE`) use `authMiddleware` + `zValidator('json', schema)` + ownership checks via `getUserId(c)`.
- Ownership: every workspace-scoped row carries `workspace_id`; mutations verify the workspace's `owner_id === getUserId(c)` (or the row's `created_by`).
- `getUserId(c)` is used everywhere — never `c.get('userId')`.
- Frontend `web/lib/api.ts` exports a `default` object; every method is `fetch('/api/proxy/<path>')` where `<path>` after `/api/proxy/` maps 1:1 to the backend path after `/api/v1/`.
- All dashboard pages are wrapped by `web/app/dashboard/layout.tsx` → `<DashboardLayout>` (sidebar chrome). `proxy.ts` matcher gates `/dashboard/:path*` and `/settings/:path*`.

---

## B. Tables (columns)

(Defined in `backend/src/db/schema.ts`; DDL in `backend/src/db/migrate.ts`.)

1. **workspaces** — id, name, slug(uniq), owner_id, description, severity_thresholds(jsonb), rotation_age_days(int), created_at, updated_at
2. **teams** — id, workspace_id(fk), name, slug, owner_email, member_ids(jsonb), created_by, created_at; UNIQUE(workspace_id, slug)
3. **providers** — id, workspace_id(fk), kind, name, base_url, org, status, created_by, created_at
4. **connections** — id, workspace_id(fk), provider_id(fk), label, scope, status, last_synced_at, last_error, config(jsonb), created_by, created_at
5. **pipelines** — id, workspace_id(fk), provider_id(fk), team_id(fk), name, repo, branch, file_path, triggers(jsonb), declared_permissions(jsonb), raw_source, risk_score(real), last_seen_at, created_at
6. **pipeline_identities** — id, workspace_id(fk), pipeline_id(fk), identity_type, name, credential_kind, is_long_lived(bool), environment, tags(jsonb), last_active_at, created_at
7. **oidc_trusts** — id, workspace_id(fk), identity_id(fk), issuer, audience, sub_claim_pattern, is_branch_scoped(bool), assumable_role_ids(jsonb), created_at
8. **roles** — id, workspace_id(fk), name, cloud, arn, policy_summary(jsonb), is_privileged(bool), created_at
9. **permissions** — id, workspace_id(fk), role_id(fk), identity_id(fk), resource_id(fk), action, effect, category, is_declared(bool), is_wildcard(bool), created_at
10. **resources** — id, workspace_id(fk), name, kind, identifier, is_crown_jewel(bool), environment, tags(jsonb), created_at
11. **actions** — id, workspace_id(fk), name, publisher, pin_type, pin_ref, is_verified_publisher(bool), inherited_privileges(jsonb), risk_level, usage_count(int), is_deprecated(bool), created_at; UNIQUE(workspace_id, name, pin_ref)
12. **pipeline_actions** — id, workspace_id(fk), pipeline_id(fk), action_id(fk), step_name, inherited_privileges(jsonb), created_at; UNIQUE(pipeline_id, action_id, step_name)
13. **secrets** — id, workspace_id(fk), name, store, is_scoped(bool), is_masked(bool), is_plaintext(bool), exposed_to_fork_pr(bool), last_rotated_at, rotation_age_days(int), created_at; UNIQUE(workspace_id, name)
14. **secret_references** — id, workspace_id(fk), secret_id(fk), pipeline_id(fk), usage_context, is_logged(bool), created_at; UNIQUE(secret_id, pipeline_id, usage_context)
15. **effective_permissions** — id, workspace_id(fk), pipeline_id(fk), action, category, resource_id(fk), source_chain(jsonb), is_excess(bool), resolved_at, created_at
16. **blast_radius** — id, workspace_id(fk), pipeline_id(fk), score(real), reachable_resource_ids(jsonb), reachable_secret_ids(jsonb), reachable_pipeline_ids(jsonb), crown_jewel_count(int), summary, computed_at, created_at
17. **attack_paths** — id, workspace_id(fk), pipeline_id(fk), from_node, from_kind, to_node, to_kind, edge_type, weight(real), created_at
18. **findings** — id, workspace_id(fk), pipeline_id(fk), detector, title, description, severity, status, evidence(jsonb), assignee, due_date, suppress_reason, created_by, created_at, updated_at
19. **recommendations** — id, workspace_id(fk), pipeline_id(fk), finding_id(fk), kind, title, detail, suggested_diff, risk_delta(real), status, applied_by, applied_at, created_at
20. **policies** — id, workspace_id(fk), name, rule_type, config(jsonb), severity, is_enabled(bool), created_by, created_at
21. **policy_violations** — id, workspace_id(fk), policy_id(fk), pipeline_id(fk), status, detail, exemption_reason, evaluated_at, created_at
22. **snapshots** — id, workspace_id(fk), label, is_baseline(bool), posture(jsonb), pipeline_count(int), finding_count(int), created_by, created_at
23. **drift_events** — id, workspace_id(fk), pipeline_id(fk), from_snapshot_id(fk), to_snapshot_id(fk), change_type, before(jsonb), after(jsonb), severity, status, created_at
24. **audits** — id, workspace_id(fk), name, schedule, status, last_run_at, summary(jsonb), created_by, created_at
25. **evidence_packs** — id, workspace_id(fk), framework, control, title, status, contents(jsonb), share_token, generated_at, created_by, created_at
26. **reports** — id, workspace_id(fk), kind, title, pipeline_id(fk), content(jsonb), format, created_by, created_at
27. **alerts** — id, workspace_id(fk), name, trigger_type, threshold(jsonb), is_enabled(bool), created_by, created_at
28. **notifications** — id, workspace_id(fk), user_id, title, body, severity, is_read(bool), link, created_at
29. **activity_log** — id, workspace_id(fk), actor_id, action, entity_type, entity_id, metadata(jsonb), created_at
30. **plans** — id(text 'free'/'pro'), name, price_cents(int), created_at
31. **subscriptions** — id, user_id(uniq), plan_id(fk text), stripe_customer_id, stripe_subscription_id, status, current_period_end, created_at, updated_at

---

## C. Backend route files (mount under /api/v1)

Each row: `METHOD path — auth? — purpose — response shape`.

### 1. `workspaces.ts` → mount `workspaces`
- `GET /` — public — list workspaces owned by header user — `Workspace[]`
- `GET /:id` — public — get one workspace — `Workspace`
- `POST /` — auth — create workspace (owner_id = user) — `Workspace`
- `PUT /:id` — auth+owner — update name/description/thresholds/rotation_age_days — `Workspace`
- `DELETE /:id` — auth+owner — delete workspace — `{ success: true }`

### 2. `providers.ts` → mount `providers`
- `GET /` — public — list providers (`?workspace_id=`) — `Provider[]`
- `GET /:id` — public — provider detail — `Provider`
- `POST /` — auth — create provider — `Provider`
- `PUT /:id` — auth+owner — update provider — `Provider`
- `DELETE /:id` — auth+owner — delete provider — `{ success: true }`

### 3. `connections.ts` → mount `connections`
- `GET /` — public — list connections (`?workspace_id=`/`?provider_id=`) — `Connection[]`
- `GET /:id` — public — connection detail — `Connection`
- `POST /` — auth — create connection — `Connection`
- `POST /:id/sync` — auth+owner — trigger deterministic sync (parses + populates pipelines/identities/actions/secrets), sets last_synced_at — `Connection`
- `DELETE /:id` — auth+owner — delete connection — `{ success: true }`

### 4. `pipelines.ts` → mount `pipelines`
- `GET /` — public — list pipelines (`?workspace_id=`/`?provider_id=`/`?team_id=`) — `Pipeline[]`
- `GET /:id` — public — pipeline detail (joins identities, actions, effective perms, blast radius) — `PipelineDetail`
- `POST /` — auth — create pipeline (parses raw_source if provided) — `Pipeline`
- `PUT /:id` — auth+owner — update pipeline — `Pipeline`
- `POST /:id/analyze` — auth+owner — recompute risk_score for pipeline — `Pipeline`
- `DELETE /:id` — auth+owner — delete pipeline — `{ success: true }`

### 5. `identities.ts` → mount `identities`
- `GET /` — public — list identities (`?workspace_id=`/`?pipeline_id=`) — `Identity[]`
- `GET /:id` — public — identity detail — `Identity`
- `POST /` — auth — create identity — `Identity`
- `PUT /:id` — auth+owner — update identity — `Identity`
- `DELETE /:id` — auth+owner — delete identity — `{ success: true }`

### 6. `oidc.ts` → mount `oidc`
- `GET /` — public — list OIDC trusts (`?workspace_id=`/`?identity_id=`) — `OidcTrust[]`
- `GET /:id` — public — trust detail — `OidcTrust`
- `POST /` — auth — create OIDC trust — `OidcTrust`
- `PUT /:id` — auth+owner — update trust (e.g. tighten sub_claim_pattern) — `OidcTrust`
- `DELETE /:id` — auth+owner — delete trust — `{ success: true }`

### 7. `roles.ts` → mount `roles`
- `GET /` — public — list roles (`?workspace_id=`) — `Role[]`
- `GET /:id` — public — role detail (with attached permissions) — `RoleDetail`
- `POST /` — auth — create role — `Role`
- `PUT /:id` — auth+owner — update role — `Role`
- `DELETE /:id` — auth+owner — delete role — `{ success: true }`

### 8. `permissions.ts` → mount `permissions`
- `GET /` — public — list permissions (`?workspace_id=`/`?role_id=`/`?identity_id=`) — `Permission[]`
- `POST /` — auth — create permission — `Permission`
- `PUT /:id` — auth+owner — update permission — `Permission`
- `DELETE /:id` — auth+owner — delete permission — `{ success: true }`

### 9. `resources.ts` → mount `resources`
- `GET /` — public — list resources (`?workspace_id=`/`?kind=`) — `Resource[]`
- `GET /crown-jewels` — public — crown-jewel resources + reachability (`?workspace_id=`) — `{ resources: Resource[], reachability: {...}[] }`
- `POST /` — auth — create resource — `Resource`
- `PUT /:id` — auth+owner — update resource (toggle crown_jewel) — `Resource`
- `DELETE /:id` — auth+owner — delete resource — `{ success: true }`

### 10. `actions.ts` → mount `actions`
- `GET /` — public — list third-party actions (`?workspace_id=`) — `Action[]`
- `GET /:id` — public — action detail + affected pipelines — `ActionDetail`
- `POST /` — auth — create action — `Action`
- `PUT /:id` — auth+owner — update action (e.g. mark pin tag→sha) — `Action`
- `DELETE /:id` — auth+owner — delete action — `{ success: true }`

### 11. `secrets.ts` → mount `secrets`
- `GET /` — public — list secrets (`?workspace_id=`) — `Secret[]`
- `GET /:id` — public — secret detail + referencing pipelines — `SecretDetail`
- `POST /` — auth — create secret — `Secret`
- `PUT /:id` — auth+owner — update secret (mark masked/scoped) — `Secret`
- `POST /:id/rotate` — auth+owner — record rotation (sets last_rotated_at, resets rotation_age_days) — `Secret`
- `DELETE /:id` — auth+owner — delete secret — `{ success: true }`

### 12. `effective.ts` → mount `effective`
- `GET /` — public — list effective permissions (`?workspace_id=`/`?pipeline_id=`) — `EffectivePermission[]`
- `POST /resolve` — auth+owner — run resolver for a workspace or pipeline (`{ workspace_id, pipeline_id? }`), regenerates effective_permissions with source chains — `{ resolved: number, pipelines: number }`

### 13. `blast-radius.ts` → mount `blast-radius`
- `GET /` — public — list blast-radius results (`?workspace_id=`) — `BlastRadius[]`
- `GET /:pipelineId` — public — blast radius for a pipeline — `BlastRadius`
- `POST /compute` — auth+owner — compute blast radius (`{ workspace_id, pipeline_id? }`) — `{ computed: number }`
- `POST /simulate` — auth+owner — what-if re-score with proposed permission changes (`{ pipeline_id, remove: string[] }`) — `{ before: number, after: number, delta: number }`

### 14. `attack-paths.ts` → mount `attack-paths`
- `GET /` — public — attack-path edges (`?workspace_id=`/`?pipeline_id=`) — `{ nodes: Node[], edges: AttackPath[] }`
- `POST /rebuild` — auth+owner — rebuild graph for workspace/pipeline (`{ workspace_id, pipeline_id? }`) — `{ edges: number }`

### 15. `findings.ts` → mount `findings`
- `GET /` — public — list findings (`?workspace_id=`/`?detector=`/`?severity=`/`?status=`) — `Finding[]`
- `GET /:id` — public — finding detail (+ linked recommendations) — `FindingDetail`
- `POST /` — auth — create finding — `Finding`
- `POST /scan` — auth+owner — run all detectors for workspace, upserts findings (`{ workspace_id }`) — `{ created: number }`
- `PUT /:id` — auth+owner — update status/assignee/severity/suppress_reason — `Finding`
- `DELETE /:id` — auth+owner — delete finding — `{ success: true }`

### 16. `recommendations.ts` → mount `recommendations`
- `GET /` — public — list recommendations (`?workspace_id=`/`?status=`) — `Recommendation[]`
- `POST /generate` — auth+owner — generate recommendations from open findings (`{ workspace_id }`) — `{ created: number }`
- `POST /:id/apply` — auth+owner — mark applied (records applied_by/applied_at, captures evidence) — `Recommendation`
- `POST /:id/dismiss` — auth+owner — dismiss recommendation — `Recommendation`

### 17. `policies.ts` → mount `policies`
- `GET /` — public — list policies (`?workspace_id=`) — `Policy[]`
- `GET /:id/violations` — public — violations for a policy — `PolicyViolation[]`
- `POST /` — auth — create policy — `Policy`
- `PUT /:id` — auth+owner — update/enable/disable policy — `Policy`
- `POST /evaluate` — auth+owner — evaluate all policies for workspace (`{ workspace_id }`), writes policy_violations — `{ violations: number }`
- `POST /violations/:id/exempt` — auth+owner — exempt a violation (reason) — `PolicyViolation`
- `DELETE /:id` — auth+owner — delete policy — `{ success: true }`

### 18. `snapshots.ts` → mount `snapshots`
- `GET /` — public — list snapshots (`?workspace_id=`) — `Snapshot[]`
- `GET /:id` — public — snapshot detail — `Snapshot`
- `POST /` — auth — create snapshot (captures current posture) — `Snapshot`
- `POST /:id/baseline` — auth+owner — pin/unpin as baseline — `Snapshot`
- `DELETE /:id` — auth+owner — delete snapshot — `{ success: true }`

### 19. `drift.ts` → mount `drift`
- `GET /` — public — list drift events (`?workspace_id=`/`?pipeline_id=`) — `DriftEvent[]`
- `POST /detect` — auth+owner — diff two snapshots (`{ workspace_id, from_snapshot_id, to_snapshot_id }`), writes drift_events — `{ events: number }`
- `PUT /:id` — auth+owner — approve/reject a drift event — `DriftEvent`

### 20. `audits.ts` → mount `audits`
- `GET /` — public — list audits (`?workspace_id=`) — `Audit[]`
- `GET /:id` — public — audit detail/summary — `Audit`
- `POST /` — auth — create audit (name + schedule) — `Audit`
- `POST /:id/run` — auth+owner — run audit (snapshot + policy eval + finding scan), updates summary/last_run_at — `Audit`
- `DELETE /:id` — auth+owner — delete audit — `{ success: true }`

### 21. `evidence.ts` → mount `evidence`
- `GET /` — public — list evidence packs (`?workspace_id=`/`?framework=`) — `EvidencePack[]`
- `GET /:id` — public — evidence pack detail (full contents) — `EvidencePack`
- `GET /coverage` — public — control coverage view (`?workspace_id=`) — `{ control: string, status: string }[]`
- `POST /generate` — auth+owner — generate a pack for a framework/control (`{ workspace_id, framework, control }`), bundles inventory + findings + secrets + drift + remediation — `EvidencePack`
- `DELETE /:id` — auth+owner — delete pack — `{ success: true }`

### 22. `reports.ts` → mount `reports`
- `GET /` — public — list reports (`?workspace_id=`/`?kind=`) — `Report[]`
- `GET /:id` — public — report detail — `Report`
- `POST /` — auth+owner — generate a report (`{ workspace_id, kind, pipeline_id?, format }`) — `Report`
- `DELETE /:id` — auth+owner — delete report — `{ success: true }`

### 23. `teams.ts` → mount `teams`
- `GET /` — public — list teams (`?workspace_id=`) — `TeamWithPosture[]`
- `GET /:id` — public — team detail (owned pipelines + finding rollup) — `TeamDetail`
- `POST /` — auth — create team — `Team`
- `PUT /:id` — auth+owner — update team/members — `Team`
- `DELETE /:id` — auth+owner — delete team — `{ success: true }`

### 24. `alerts.ts` → mount `alerts`
- `GET /` — public — list alert rules (`?workspace_id=`) — `Alert[]`
- `POST /` — auth — create alert rule — `Alert`
- `PUT /:id` — auth+owner — update/enable/disable alert — `Alert`
- `DELETE /:id` — auth+owner — delete alert — `{ success: true }`

### 25. `notifications.ts` → mount `notifications`
- `GET /` — public — list notifications for header user (`?workspace_id=`) — `Notification[]`
- `POST /:id/read` — auth — mark notification read — `Notification`
- `POST /read-all` — auth — mark all read (`{ workspace_id }`) — `{ updated: number }`

### 26. `activity.ts` → mount `activity`
- `GET /` — public — list activity log (`?workspace_id=`/`?actor_id=`/`?entity_type=`) — `ActivityEntry[]`
- `POST /` — auth — append an activity entry — `ActivityEntry`

### 27. `analyzer.ts` → mount `analyzer`
- `POST /parse` — auth — parse pasted workflow YAML/Jenkinsfile into normalized model (no persistence) — `{ jobs, steps, permissions, uses, secrets }`
- `POST /analyze` — auth — inline least-privilege + risk analysis of pasted workflow (no persistence) — `{ findings: InlineFinding[], risk_score: number, recommended_permissions: object }`

### 28. `stats.ts` → mount `stats`
- `GET /overview` — public — workspace posture overview (`?workspace_id=`): pipeline count, identity count, finding mix by severity, avg risk_score, crown-jewel reachability, control coverage — `OverviewStats`
- `GET /risk-trend` — public — risk-score trend across snapshots (`?workspace_id=`) — `{ label, score }[]`

### 29. `billing.ts` → mount `billing`
- `GET /plan` — public — current subscription + plan (auto-creates free sub) — `{ subscription, plan, stripeEnabled }`
- `POST /checkout` — public — Stripe checkout (503 if unconfigured) — `{ url }` or 503
- `POST /portal` — public — Stripe billing portal (503 if unconfigured) — `{ url }` or 503
- `POST /webhook` — public — Stripe webhook (503 if unconfigured) — `{ received: true }`

### 30. `seed.ts` → mount `seed`
- `POST /sample` — auth — seed a fully-populated sample workspace for the header user (providers, pipelines, identities, OIDC trusts, roles, permissions, resources, actions, secrets, effective perms, blast radius, attack paths, findings, recommendations, policies, snapshots, drift, audits, evidence, reports, teams, alerts, notifications, activity) — `{ workspace_id }`
- `DELETE /sample` — auth — delete the header user's sample workspace and all child rows — `{ success: true }`

---

## D. `web/lib/api.ts` method list

Each: `methodName` → `VERB /api/proxy/<path>`.

**Workspaces**
- `listWorkspaces()` → GET `/api/proxy/workspaces`
- `getWorkspace(id)` → GET `/api/proxy/workspaces/${id}`
- `createWorkspace(body)` → POST `/api/proxy/workspaces`
- `updateWorkspace(id, body)` → PUT `/api/proxy/workspaces/${id}`
- `deleteWorkspace(id)` → DELETE `/api/proxy/workspaces/${id}`

**Providers**
- `listProviders(workspaceId)` → GET `/api/proxy/providers?workspace_id=${workspaceId}`
- `getProvider(id)` → GET `/api/proxy/providers/${id}`
- `createProvider(body)` → POST `/api/proxy/providers`
- `updateProvider(id, body)` → PUT `/api/proxy/providers/${id}`
- `deleteProvider(id)` → DELETE `/api/proxy/providers/${id}`

**Connections**
- `listConnections(workspaceId)` → GET `/api/proxy/connections?workspace_id=${workspaceId}`
- `getConnection(id)` → GET `/api/proxy/connections/${id}`
- `createConnection(body)` → POST `/api/proxy/connections`
- `syncConnection(id)` → POST `/api/proxy/connections/${id}/sync`
- `deleteConnection(id)` → DELETE `/api/proxy/connections/${id}`

**Pipelines**
- `listPipelines(workspaceId)` → GET `/api/proxy/pipelines?workspace_id=${workspaceId}`
- `getPipeline(id)` → GET `/api/proxy/pipelines/${id}`
- `createPipeline(body)` → POST `/api/proxy/pipelines`
- `updatePipeline(id, body)` → PUT `/api/proxy/pipelines/${id}`
- `analyzePipeline(id)` → POST `/api/proxy/pipelines/${id}/analyze`
- `deletePipeline(id)` → DELETE `/api/proxy/pipelines/${id}`

**Identities**
- `listIdentities(workspaceId)` → GET `/api/proxy/identities?workspace_id=${workspaceId}`
- `getIdentity(id)` → GET `/api/proxy/identities/${id}`
- `createIdentity(body)` → POST `/api/proxy/identities`
- `updateIdentity(id, body)` → PUT `/api/proxy/identities/${id}`
- `deleteIdentity(id)` → DELETE `/api/proxy/identities/${id}`

**OIDC**
- `listOidcTrusts(workspaceId)` → GET `/api/proxy/oidc?workspace_id=${workspaceId}`
- `getOidcTrust(id)` → GET `/api/proxy/oidc/${id}`
- `createOidcTrust(body)` → POST `/api/proxy/oidc`
- `updateOidcTrust(id, body)` → PUT `/api/proxy/oidc/${id}`
- `deleteOidcTrust(id)` → DELETE `/api/proxy/oidc/${id}`

**Roles**
- `listRoles(workspaceId)` → GET `/api/proxy/roles?workspace_id=${workspaceId}`
- `getRole(id)` → GET `/api/proxy/roles/${id}`
- `createRole(body)` → POST `/api/proxy/roles`
- `updateRole(id, body)` → PUT `/api/proxy/roles/${id}`
- `deleteRole(id)` → DELETE `/api/proxy/roles/${id}`

**Permissions**
- `listPermissions(workspaceId)` → GET `/api/proxy/permissions?workspace_id=${workspaceId}`
- `createPermission(body)` → POST `/api/proxy/permissions`
- `updatePermission(id, body)` → PUT `/api/proxy/permissions/${id}`
- `deletePermission(id)` → DELETE `/api/proxy/permissions/${id}`

**Resources**
- `listResources(workspaceId)` → GET `/api/proxy/resources?workspace_id=${workspaceId}`
- `getCrownJewels(workspaceId)` → GET `/api/proxy/resources/crown-jewels?workspace_id=${workspaceId}`
- `createResource(body)` → POST `/api/proxy/resources`
- `updateResource(id, body)` → PUT `/api/proxy/resources/${id}`
- `deleteResource(id)` → DELETE `/api/proxy/resources/${id}`

**Actions**
- `listActions(workspaceId)` → GET `/api/proxy/actions?workspace_id=${workspaceId}`
- `getAction(id)` → GET `/api/proxy/actions/${id}`
- `createAction(body)` → POST `/api/proxy/actions`
- `updateAction(id, body)` → PUT `/api/proxy/actions/${id}`
- `deleteAction(id)` → DELETE `/api/proxy/actions/${id}`

**Secrets**
- `listSecrets(workspaceId)` → GET `/api/proxy/secrets?workspace_id=${workspaceId}`
- `getSecret(id)` → GET `/api/proxy/secrets/${id}`
- `createSecret(body)` → POST `/api/proxy/secrets`
- `updateSecret(id, body)` → PUT `/api/proxy/secrets/${id}`
- `rotateSecret(id)` → POST `/api/proxy/secrets/${id}/rotate`
- `deleteSecret(id)` → DELETE `/api/proxy/secrets/${id}`

**Effective permissions**
- `listEffective(workspaceId)` → GET `/api/proxy/effective?workspace_id=${workspaceId}`
- `resolveEffective(body)` → POST `/api/proxy/effective/resolve`

**Blast radius**
- `listBlastRadius(workspaceId)` → GET `/api/proxy/blast-radius?workspace_id=${workspaceId}`
- `getBlastRadius(pipelineId)` → GET `/api/proxy/blast-radius/${pipelineId}`
- `computeBlastRadius(body)` → POST `/api/proxy/blast-radius/compute`
- `simulateBlastRadius(body)` → POST `/api/proxy/blast-radius/simulate`

**Attack paths**
- `getAttackPaths(workspaceId, pipelineId?)` → GET `/api/proxy/attack-paths?workspace_id=${workspaceId}`
- `rebuildAttackPaths(body)` → POST `/api/proxy/attack-paths/rebuild`

**Findings**
- `listFindings(workspaceId)` → GET `/api/proxy/findings?workspace_id=${workspaceId}`
- `getFinding(id)` → GET `/api/proxy/findings/${id}`
- `createFinding(body)` → POST `/api/proxy/findings`
- `scanFindings(body)` → POST `/api/proxy/findings/scan`
- `updateFinding(id, body)` → PUT `/api/proxy/findings/${id}`
- `deleteFinding(id)` → DELETE `/api/proxy/findings/${id}`

**Recommendations**
- `listRecommendations(workspaceId)` → GET `/api/proxy/recommendations?workspace_id=${workspaceId}`
- `generateRecommendations(body)` → POST `/api/proxy/recommendations/generate`
- `applyRecommendation(id)` → POST `/api/proxy/recommendations/${id}/apply`
- `dismissRecommendation(id)` → POST `/api/proxy/recommendations/${id}/dismiss`

**Policies**
- `listPolicies(workspaceId)` → GET `/api/proxy/policies?workspace_id=${workspaceId}`
- `getPolicyViolations(id)` → GET `/api/proxy/policies/${id}/violations`
- `createPolicy(body)` → POST `/api/proxy/policies`
- `updatePolicy(id, body)` → PUT `/api/proxy/policies/${id}`
- `evaluatePolicies(body)` → POST `/api/proxy/policies/evaluate`
- `exemptViolation(id, body)` → POST `/api/proxy/policies/violations/${id}/exempt`
- `deletePolicy(id)` → DELETE `/api/proxy/policies/${id}`

**Snapshots**
- `listSnapshots(workspaceId)` → GET `/api/proxy/snapshots?workspace_id=${workspaceId}`
- `getSnapshot(id)` → GET `/api/proxy/snapshots/${id}`
- `createSnapshot(body)` → POST `/api/proxy/snapshots`
- `setBaseline(id)` → POST `/api/proxy/snapshots/${id}/baseline`
- `deleteSnapshot(id)` → DELETE `/api/proxy/snapshots/${id}`

**Drift**
- `listDrift(workspaceId)` → GET `/api/proxy/drift?workspace_id=${workspaceId}`
- `detectDrift(body)` → POST `/api/proxy/drift/detect`
- `updateDrift(id, body)` → PUT `/api/proxy/drift/${id}`

**Audits**
- `listAudits(workspaceId)` → GET `/api/proxy/audits?workspace_id=${workspaceId}`
- `getAudit(id)` → GET `/api/proxy/audits/${id}`
- `createAudit(body)` → POST `/api/proxy/audits`
- `runAudit(id)` → POST `/api/proxy/audits/${id}/run`
- `deleteAudit(id)` → DELETE `/api/proxy/audits/${id}`

**Evidence**
- `listEvidence(workspaceId)` → GET `/api/proxy/evidence?workspace_id=${workspaceId}`
- `getEvidence(id)` → GET `/api/proxy/evidence/${id}`
- `getControlCoverage(workspaceId)` → GET `/api/proxy/evidence/coverage?workspace_id=${workspaceId}`
- `generateEvidence(body)` → POST `/api/proxy/evidence/generate`
- `deleteEvidence(id)` → DELETE `/api/proxy/evidence/${id}`

**Reports**
- `listReports(workspaceId)` → GET `/api/proxy/reports?workspace_id=${workspaceId}`
- `getReport(id)` → GET `/api/proxy/reports/${id}`
- `generateReport(body)` → POST `/api/proxy/reports`
- `deleteReport(id)` → DELETE `/api/proxy/reports/${id}`

**Teams**
- `listTeams(workspaceId)` → GET `/api/proxy/teams?workspace_id=${workspaceId}`
- `getTeam(id)` → GET `/api/proxy/teams/${id}`
- `createTeam(body)` → POST `/api/proxy/teams`
- `updateTeam(id, body)` → PUT `/api/proxy/teams/${id}`
- `deleteTeam(id)` → DELETE `/api/proxy/teams/${id}`

**Alerts**
- `listAlerts(workspaceId)` → GET `/api/proxy/alerts?workspace_id=${workspaceId}`
- `createAlert(body)` → POST `/api/proxy/alerts`
- `updateAlert(id, body)` → PUT `/api/proxy/alerts/${id}`
- `deleteAlert(id)` → DELETE `/api/proxy/alerts/${id}`

**Notifications**
- `listNotifications(workspaceId)` → GET `/api/proxy/notifications?workspace_id=${workspaceId}`
- `markNotificationRead(id)` → POST `/api/proxy/notifications/${id}/read`
- `markAllNotificationsRead(body)` → POST `/api/proxy/notifications/read-all`

**Activity**
- `listActivity(workspaceId)` → GET `/api/proxy/activity?workspace_id=${workspaceId}`
- `logActivity(body)` → POST `/api/proxy/activity`

**Analyzer**
- `parseWorkflow(body)` → POST `/api/proxy/analyzer/parse`
- `analyzeWorkflow(body)` → POST `/api/proxy/analyzer/analyze`

**Stats**
- `getOverview(workspaceId)` → GET `/api/proxy/stats/overview?workspace_id=${workspaceId}`
- `getRiskTrend(workspaceId)` → GET `/api/proxy/stats/risk-trend?workspace_id=${workspaceId}`

**Billing**
- `getBillingPlan()` → GET `/api/proxy/billing/plan`
- `startCheckout()` → POST `/api/proxy/billing/checkout`
- `openPortal()` → POST `/api/proxy/billing/portal`

**Seed**
- `seedSample()` → POST `/api/proxy/seed/sample`
- `deleteSample()` → DELETE `/api/proxy/seed/sample`

---

## E. Page list

`kind`: public | dashboard. Dashboard pages wrapped by `web/app/dashboard/layout.tsx`.

### Public
1. `/` — `web/app/page.tsx` — public — uses: none (static landing) — renders hero, feature grid (the 7 flagship capabilities), CTAs to sign-up/sign-in.
2. `/auth/sign-in` — `web/app/auth/sign-in/page.tsx` — public — uses: `authClient` — email/password sign-in form.
3. `/auth/sign-up` — `web/app/auth/sign-up/page.tsx` — public — uses: `authClient` — email/password sign-up form.
4. `/pricing` — `web/app/pricing/page.tsx` — public — uses: `getBillingPlan` — Free vs Pro plans, checkout CTA.

### Dashboard
5. `/dashboard` — `web/app/dashboard/page.tsx` — dashboard — uses: `getOverview`, `getRiskTrend`, `listWorkspaces`, `seedSample` — posture overview: KPI cards (pipelines, identities, findings by severity, avg risk), risk trend, crown-jewel reachability, "seed sample data" button when empty.
6. `/dashboard/providers` — `web/app/dashboard/providers/page.tsx` — dashboard — uses: `listProviders`, `createProvider`, `updateProvider`, `deleteProvider`, `listConnections`, `createConnection`, `syncConnection`, `deleteConnection` — provider connections + ingestion runs (sync button, last-sync/status).
7. `/dashboard/pipelines` — `web/app/dashboard/pipelines/page.tsx` — dashboard — uses: `listPipelines`, `createPipeline`, `deletePipeline`, `analyzePipeline` — pipeline inventory table (repo, branch, risk score, provider) with create/delete.
8. `/dashboard/pipelines/[id]` — `web/app/dashboard/pipelines/[id]/page.tsx` — dashboard — uses: `getPipeline`, `analyzePipeline`, `listEffective`, `getBlastRadius`, `computeBlastRadius`, `simulateBlastRadius`, `updatePipeline` — pipeline deep-dive: identities, declared vs effective perms, used actions, blast radius, what-if simulation.
9. `/dashboard/identities` — `web/app/dashboard/identities/page.tsx` — dashboard — uses: `listIdentities`, `createIdentity`, `updateIdentity`, `deleteIdentity`, `listOidcTrusts`, `createOidcTrust`, `updateOidcTrust`, `deleteOidcTrust` — identity inventory + OIDC trust configs (issuer/audience/sub pattern, branch-scoped flag).
10. `/dashboard/effective` — `web/app/dashboard/effective/page.tsx` — dashboard — uses: `listEffective`, `resolveEffective`, `listPipelines` — effective-permission explorer: filter by pipeline/category, show source chain, excess flag, "resolve" button.
11. `/dashboard/over-privilege` — `web/app/dashboard/over-privilege/page.tsx` — dashboard — uses: `listFindings`, `scanFindings`, `updateFinding`, `generateRecommendations` — over-privilege findings (detector=over_privilege) with severity, acknowledge/remediate, least-privilege recommendation.
12. `/dashboard/actions` — `web/app/dashboard/actions/page.tsx` — dashboard — uses: `listActions`, `getAction`, `createAction`, `updateAction`, `deleteAction` — third-party Action risk map: pin type, publisher, inherited privileges, usage count, pin tag→sha recommendation.
13. `/dashboard/blast-radius` — `web/app/dashboard/blast-radius/page.tsx` — dashboard — uses: `listBlastRadius`, `computeBlastRadius`, `getAttackPaths`, `rebuildAttackPaths` — blast-radius explorer: ranked pipelines by score, reachable resources/secrets/pipelines, attack-path graph.
14. `/dashboard/secrets` — `web/app/dashboard/secrets/page.tsx` — dashboard — uses: `listSecrets`, `getSecret`, `createSecret`, `updateSecret`, `rotateSecret`, `deleteSecret` — secret-in-CI tracker: scoped/masked/plaintext/fork-PR flags, rotation age, rotate button.
15. `/dashboard/drift` — `web/app/dashboard/drift/page.tsx` — dashboard — uses: `listSnapshots`, `createSnapshot`, `setBaseline`, `deleteSnapshot`, `listDrift`, `detectDrift`, `updateDrift` — drift timeline: snapshots, baseline pin, detect-drift between snapshots, approve/reject events.
16. `/dashboard/evidence` — `web/app/dashboard/evidence/page.tsx` — dashboard — uses: `listEvidence`, `getEvidence`, `getControlCoverage`, `generateEvidence`, `deleteEvidence` — SOC2/SLSA evidence packs: control coverage grid, generate pack, view/export contents.
17. `/dashboard/findings` — `web/app/dashboard/findings/page.tsx` — dashboard — uses: `listFindings`, `getFinding`, `scanFindings`, `updateFinding`, `deleteFinding` — unified findings workspace: filter by detector/severity/status, assign, status workflow.
18. `/dashboard/recommendations` — `web/app/dashboard/recommendations/page.tsx` — dashboard — uses: `listRecommendations`, `generateRecommendations`, `applyRecommendation`, `dismissRecommendation` — recommendations center: suggested diffs, risk delta, mark applied/dismiss.
19. `/dashboard/policies` — `web/app/dashboard/policies/page.tsx` — dashboard — uses: `listPolicies`, `createPolicy`, `updatePolicy`, `deletePolicy`, `getPolicyViolations`, `evaluatePolicies`, `exemptViolation` — policy engine: rule list, enable/disable, evaluate, per-policy violations, exempt.
20. `/dashboard/resources` — `web/app/dashboard/resources/page.tsx` — dashboard — uses: `listResources`, `createResource`, `updateResource`, `deleteResource`, `getCrownJewels` — resource & crown-jewel catalog: mark crown jewel, reachability report.
21. `/dashboard/roles` — `web/app/dashboard/roles/page.tsx` — dashboard — uses: `listRoles`, `getRole`, `createRole`, `updateRole`, `deleteRole`, `listPermissions`, `createPermission`, `updatePermission`, `deletePermission` — roles & permissions: cloud roles, attached permissions, privileged flag.
22. `/dashboard/analyzer` — `web/app/dashboard/analyzer/page.tsx` — dashboard — uses: `parseWorkflow`, `analyzeWorkflow` — paste-a-workflow analyzer: textarea, parsed model, inline findings + recommended permissions (no persistence).
23. `/dashboard/audits` — `web/app/dashboard/audits/page.tsx` — dashboard — uses: `listAudits`, `getAudit`, `createAudit`, `runAudit`, `deleteAudit` — scheduled audits: schedule, run now, audit summary history.
24. `/dashboard/reports` — `web/app/dashboard/reports/page.tsx` — dashboard — uses: `listReports`, `getReport`, `generateReport`, `deleteReport` — reports: generate exec summary / pipeline deep-dive / blast-radius / secret-hygiene, view, export.
25. `/dashboard/teams` — `web/app/dashboard/teams/page.tsx` — dashboard — uses: `listTeams`, `getTeam`, `createTeam`, `updateTeam`, `deleteTeam` — teams & ownership: per-team posture, finding rollup, member management.
26. `/dashboard/alerts` — `web/app/dashboard/alerts/page.tsx` — dashboard — uses: `listAlerts`, `createAlert`, `updateAlert`, `deleteAlert`, `listNotifications`, `markNotificationRead`, `markAllNotificationsRead` — alert rules + notifications feed.
27. `/dashboard/activity` — `web/app/dashboard/activity/page.tsx` — dashboard — uses: `listActivity` — immutable activity log, filter by actor/entity.
28. `/dashboard/settings` — `web/app/dashboard/settings/page.tsx` — dashboard — uses: `listWorkspaces`, `getWorkspace`, `createWorkspace`, `updateWorkspace`, `getBillingPlan`, `seedSample`, `deleteSample` — workspace settings (name, severity thresholds, rotation age), billing/plan, seed/reset sample data.

---

## F. DashboardLayout sidebar nav

`web/components/DashboardLayout.tsx` — `'use client'`, `<aside>` with `usePathname()` active state, mobile drawer. Sections:

- **Overview**
  - Dashboard → `/dashboard`
- **Inventory**
  - Providers → `/dashboard/providers`
  - Pipelines → `/dashboard/pipelines`
  - Identities → `/dashboard/identities`
  - Roles & Permissions → `/dashboard/roles`
  - Resources → `/dashboard/resources`
  - Actions → `/dashboard/actions`
  - Secrets → `/dashboard/secrets`
- **Analysis**
  - Effective Permissions → `/dashboard/effective`
  - Over-Privilege → `/dashboard/over-privilege`
  - Blast Radius → `/dashboard/blast-radius`
  - Drift → `/dashboard/drift`
  - Analyzer → `/dashboard/analyzer`
- **Governance**
  - Findings → `/dashboard/findings`
  - Recommendations → `/dashboard/recommendations`
  - Policies → `/dashboard/policies`
  - Evidence → `/dashboard/evidence`
  - Audits → `/dashboard/audits`
  - Reports → `/dashboard/reports`
- **Workspace**
  - Teams → `/dashboard/teams`
  - Alerts & Notifications → `/dashboard/alerts`
  - Activity Log → `/dashboard/activity`
  - Settings → `/dashboard/settings`

---

## G. Consistency guarantees

- Every `lib/api.ts` method maps to exactly one backend endpoint in section C.
- Every backend endpoint is consumed by at least one page in section E (or is billing/seed infra).
- 30 route files, 28 pages (24 dashboard + 4 public), 31 tables (29 domain + plans + subscriptions).
- Billing uses the full Stripe-optional-503 pattern (text `plan_id`, `plans`/`subscriptions` tables) — add `stripe` dep to backend `package.json`.
- `migrate()` from `db/migrate.ts` is invoked once at startup in `index.ts` before `seedIfEmpty()`, then `plans` seeded with 'free'/'pro'.
