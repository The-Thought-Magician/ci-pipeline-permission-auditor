// Same-origin relative calls to the Next.js proxy route, which injects X-User-Id
// and forwards to the backend at /api/v1/<path>. Every method maps 1:1 to a
// backend endpoint declared in docs/build-plan.md section C.

async function req(path: string, init?: RequestInit) {
  const res = await fetch(`/api/proxy/${path}`, init)
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const message = (data && (data.error || data.message)) || `Request failed (${res.status})`
    throw new Error(message)
  }
  return data
}

function get(path: string) {
  return req(path)
}
function post(path: string, body?: unknown) {
  return req(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
function put(path: string, body?: unknown) {
  return req(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
function del(path: string) {
  return req(path, { method: 'DELETE' })
}

const qs = (workspaceId: string) => `workspace_id=${encodeURIComponent(workspaceId)}`

const api = {
  // Workspaces
  listWorkspaces: () => get('workspaces'),
  getWorkspace: (id: string) => get(`workspaces/${id}`),
  createWorkspace: (body: unknown) => post('workspaces', body),
  updateWorkspace: (id: string, body: unknown) => put(`workspaces/${id}`, body),
  deleteWorkspace: (id: string) => del(`workspaces/${id}`),

  // Providers
  listProviders: (workspaceId: string) => get(`providers?${qs(workspaceId)}`),
  getProvider: (id: string) => get(`providers/${id}`),
  createProvider: (body: unknown) => post('providers', body),
  updateProvider: (id: string, body: unknown) => put(`providers/${id}`, body),
  deleteProvider: (id: string) => del(`providers/${id}`),

  // Connections
  listConnections: (workspaceId: string) => get(`connections?${qs(workspaceId)}`),
  getConnection: (id: string) => get(`connections/${id}`),
  createConnection: (body: unknown) => post('connections', body),
  syncConnection: (id: string) => post(`connections/${id}/sync`),
  deleteConnection: (id: string) => del(`connections/${id}`),

  // Pipelines
  listPipelines: (workspaceId: string) => get(`pipelines?${qs(workspaceId)}`),
  getPipeline: (id: string) => get(`pipelines/${id}`),
  createPipeline: (body: unknown) => post('pipelines', body),
  updatePipeline: (id: string, body: unknown) => put(`pipelines/${id}`, body),
  analyzePipeline: (id: string) => post(`pipelines/${id}/analyze`),
  deletePipeline: (id: string) => del(`pipelines/${id}`),

  // Identities
  listIdentities: (workspaceId: string) => get(`identities?${qs(workspaceId)}`),
  getIdentity: (id: string) => get(`identities/${id}`),
  createIdentity: (body: unknown) => post('identities', body),
  updateIdentity: (id: string, body: unknown) => put(`identities/${id}`, body),
  deleteIdentity: (id: string) => del(`identities/${id}`),

  // OIDC
  listOidcTrusts: (workspaceId: string) => get(`oidc?${qs(workspaceId)}`),
  getOidcTrust: (id: string) => get(`oidc/${id}`),
  createOidcTrust: (body: unknown) => post('oidc', body),
  updateOidcTrust: (id: string, body: unknown) => put(`oidc/${id}`, body),
  deleteOidcTrust: (id: string) => del(`oidc/${id}`),

  // Roles
  listRoles: (workspaceId: string) => get(`roles?${qs(workspaceId)}`),
  getRole: (id: string) => get(`roles/${id}`),
  createRole: (body: unknown) => post('roles', body),
  updateRole: (id: string, body: unknown) => put(`roles/${id}`, body),
  deleteRole: (id: string) => del(`roles/${id}`),

  // Permissions
  listPermissions: (workspaceId: string) => get(`permissions?${qs(workspaceId)}`),
  createPermission: (body: unknown) => post('permissions', body),
  updatePermission: (id: string, body: unknown) => put(`permissions/${id}`, body),
  deletePermission: (id: string) => del(`permissions/${id}`),

  // Resources
  listResources: (workspaceId: string) => get(`resources?${qs(workspaceId)}`),
  getCrownJewels: (workspaceId: string) => get(`resources/crown-jewels?${qs(workspaceId)}`),
  createResource: (body: unknown) => post('resources', body),
  updateResource: (id: string, body: unknown) => put(`resources/${id}`, body),
  deleteResource: (id: string) => del(`resources/${id}`),

  // Actions
  listActions: (workspaceId: string) => get(`actions?${qs(workspaceId)}`),
  getAction: (id: string) => get(`actions/${id}`),
  createAction: (body: unknown) => post('actions', body),
  updateAction: (id: string, body: unknown) => put(`actions/${id}`, body),
  deleteAction: (id: string) => del(`actions/${id}`),

  // Secrets
  listSecrets: (workspaceId: string) => get(`secrets?${qs(workspaceId)}`),
  getSecret: (id: string) => get(`secrets/${id}`),
  createSecret: (body: unknown) => post('secrets', body),
  updateSecret: (id: string, body: unknown) => put(`secrets/${id}`, body),
  rotateSecret: (id: string) => post(`secrets/${id}/rotate`),
  deleteSecret: (id: string) => del(`secrets/${id}`),

  // Effective permissions
  listEffective: (workspaceId: string) => get(`effective?${qs(workspaceId)}`),
  resolveEffective: (body: unknown) => post('effective/resolve', body),

  // Blast radius
  listBlastRadius: (workspaceId: string) => get(`blast-radius?${qs(workspaceId)}`),
  getBlastRadius: (pipelineId: string) => get(`blast-radius/${pipelineId}`),
  computeBlastRadius: (body: unknown) => post('blast-radius/compute', body),
  simulateBlastRadius: (body: unknown) => post('blast-radius/simulate', body),

  // Attack paths
  getAttackPaths: (workspaceId: string, pipelineId?: string) =>
    get(`attack-paths?${qs(workspaceId)}${pipelineId ? `&pipeline_id=${encodeURIComponent(pipelineId)}` : ''}`),
  rebuildAttackPaths: (body: unknown) => post('attack-paths/rebuild', body),

  // Findings
  listFindings: (workspaceId: string) => get(`findings?${qs(workspaceId)}`),
  getFinding: (id: string) => get(`findings/${id}`),
  createFinding: (body: unknown) => post('findings', body),
  scanFindings: (body: unknown) => post('findings/scan', body),
  updateFinding: (id: string, body: unknown) => put(`findings/${id}`, body),
  deleteFinding: (id: string) => del(`findings/${id}`),

  // Recommendations
  listRecommendations: (workspaceId: string) => get(`recommendations?${qs(workspaceId)}`),
  generateRecommendations: (body: unknown) => post('recommendations/generate', body),
  applyRecommendation: (id: string) => post(`recommendations/${id}/apply`),
  dismissRecommendation: (id: string) => post(`recommendations/${id}/dismiss`),

  // Policies
  listPolicies: (workspaceId: string) => get(`policies?${qs(workspaceId)}`),
  getPolicyViolations: (id: string) => get(`policies/${id}/violations`),
  createPolicy: (body: unknown) => post('policies', body),
  updatePolicy: (id: string, body: unknown) => put(`policies/${id}`, body),
  evaluatePolicies: (body: unknown) => post('policies/evaluate', body),
  exemptViolation: (id: string, body: unknown) => post(`policies/violations/${id}/exempt`, body),
  deletePolicy: (id: string) => del(`policies/${id}`),

  // Snapshots
  listSnapshots: (workspaceId: string) => get(`snapshots?${qs(workspaceId)}`),
  getSnapshot: (id: string) => get(`snapshots/${id}`),
  createSnapshot: (body: unknown) => post('snapshots', body),
  setBaseline: (id: string) => post(`snapshots/${id}/baseline`),
  deleteSnapshot: (id: string) => del(`snapshots/${id}`),

  // Drift
  listDrift: (workspaceId: string) => get(`drift?${qs(workspaceId)}`),
  detectDrift: (body: unknown) => post('drift/detect', body),
  updateDrift: (id: string, body: unknown) => put(`drift/${id}`, body),

  // Audits
  listAudits: (workspaceId: string) => get(`audits?${qs(workspaceId)}`),
  getAudit: (id: string) => get(`audits/${id}`),
  createAudit: (body: unknown) => post('audits', body),
  runAudit: (id: string) => post(`audits/${id}/run`),
  deleteAudit: (id: string) => del(`audits/${id}`),

  // Evidence
  listEvidence: (workspaceId: string) => get(`evidence?${qs(workspaceId)}`),
  getEvidence: (id: string) => get(`evidence/${id}`),
  getControlCoverage: (workspaceId: string) => get(`evidence/coverage?${qs(workspaceId)}`),
  generateEvidence: (body: unknown) => post('evidence/generate', body),
  deleteEvidence: (id: string) => del(`evidence/${id}`),

  // Reports
  listReports: (workspaceId: string) => get(`reports?${qs(workspaceId)}`),
  getReport: (id: string) => get(`reports/${id}`),
  generateReport: (body: unknown) => post('reports', body),
  deleteReport: (id: string) => del(`reports/${id}`),

  // Teams
  listTeams: (workspaceId: string) => get(`teams?${qs(workspaceId)}`),
  getTeam: (id: string) => get(`teams/${id}`),
  createTeam: (body: unknown) => post('teams', body),
  updateTeam: (id: string, body: unknown) => put(`teams/${id}`, body),
  deleteTeam: (id: string) => del(`teams/${id}`),

  // Alerts
  listAlerts: (workspaceId: string) => get(`alerts?${qs(workspaceId)}`),
  createAlert: (body: unknown) => post('alerts', body),
  updateAlert: (id: string, body: unknown) => put(`alerts/${id}`, body),
  deleteAlert: (id: string) => del(`alerts/${id}`),

  // Notifications
  listNotifications: (workspaceId: string) => get(`notifications?${qs(workspaceId)}`),
  markNotificationRead: (id: string) => post(`notifications/${id}/read`),
  markAllNotificationsRead: (body: unknown) => post('notifications/read-all', body),

  // Activity
  listActivity: (workspaceId: string) => get(`activity?${qs(workspaceId)}`),
  logActivity: (body: unknown) => post('activity', body),

  // Analyzer
  parseWorkflow: (body: unknown) => post('analyzer/parse', body),
  analyzeWorkflow: (body: unknown) => post('analyzer/analyze', body),

  // Stats
  getOverview: (workspaceId: string) => get(`stats/overview?${qs(workspaceId)}`),
  getRiskTrend: (workspaceId: string) => get(`stats/risk-trend?${qs(workspaceId)}`),

  // Billing
  getBillingPlan: () => get('billing/plan'),
  startCheckout: () => post('billing/checkout'),
  openPortal: () => post('billing/portal'),

  // Seed
  seedSample: () => post('seed/sample'),
  deleteSample: () => del('seed/sample'),
}

export default api
