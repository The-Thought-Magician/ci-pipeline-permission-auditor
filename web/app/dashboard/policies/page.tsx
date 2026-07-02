'use client'

import { useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge, severityTone } from '@/components/ui/Badge'
import { Stat } from '@/components/ui/Stat'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Modal } from '@/components/ui/Modal'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'

interface Workspace {
  id: string
  name: string
}

interface Policy {
  id: string
  workspace_id: string
  name: string
  rule_type: string
  config: unknown
  severity: string
  is_enabled: boolean
  created_by: string | null
  created_at: string
}

interface PolicyViolation {
  id: string
  workspace_id: string
  policy_id: string
  pipeline_id: string | null
  status: string
  detail: string | null
  exemption_reason: string | null
  evaluated_at: string | null
  created_at: string
}

const RULE_TYPES = [
  'require_oidc',
  'no_long_lived_secrets',
  'pin_actions_to_sha',
  'least_privilege',
  'mask_secrets',
  'no_wildcard_permissions',
  'verified_publishers_only',
  'rotate_secrets',
]
const SEVERITIES = ['critical', 'high', 'medium', 'low']

function fmtRule(r: string) {
  return r.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function fmtDate(s?: string | null) {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

function violationTone(status: string): 'critical' | 'success' | 'neutral' | 'info' {
  switch (status) {
    case 'violating':
    case 'open':
      return 'critical'
    case 'passing':
    case 'resolved':
      return 'success'
    case 'exempted':
      return 'neutral'
    default:
      return 'info'
  }
}

interface PolicyForm {
  name: string
  rule_type: string
  severity: string
  is_enabled: boolean
  config: string
}

const EMPTY_FORM: PolicyForm = {
  name: '',
  rule_type: RULE_TYPES[0],
  severity: 'high',
  is_enabled: true,
  config: '{}',
}

export default function PoliciesPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [policies, setPolicies] = useState<Policy[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [severityFilter, setSeverityFilter] = useState('all')
  const [enabledFilter, setEnabledFilter] = useState('all')

  // create/edit form
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Policy | null>(null)
  const [form, setForm] = useState<PolicyForm>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)

  // violations panel
  const [viewPolicy, setViewPolicy] = useState<Policy | null>(null)
  const [violations, setViolations] = useState<PolicyViolation[]>([])
  const [violationsLoading, setViolationsLoading] = useState(false)

  async function loadPolicies(wsId: string) {
    const all: Policy[] = await api.listPolicies(wsId)
    setPolicies(all)
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const workspaces: Workspace[] = await api.listWorkspaces()
        if (cancelled) return
        if (!workspaces.length) {
          setWorkspaceId(null)
          setLoading(false)
          return
        }
        const wsId = workspaces[0].id
        setWorkspaceId(wsId)
        await loadPolicies(wsId)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load policies')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const stats = useMemo(() => {
    let enabled = 0
    for (const p of policies) if (p.is_enabled) enabled += 1
    return { total: policies.length, enabled, disabled: policies.length - enabled }
  }, [policies])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return policies
      .filter((p) => severityFilter === 'all' || p.severity?.toLowerCase() === severityFilter)
      .filter((p) =>
        enabledFilter === 'all' ? true : enabledFilter === 'enabled' ? p.is_enabled : !p.is_enabled,
      )
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.rule_type.toLowerCase().includes(q))
  }, [policies, search, severityFilter, enabledFilter])

  function flash(msg: string) {
    setBanner(msg)
    setTimeout(() => setBanner(null), 4000)
  }

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormError(null)
    setFormOpen(true)
  }

  function openEdit(p: Policy) {
    setEditing(p)
    setForm({
      name: p.name,
      rule_type: p.rule_type,
      severity: p.severity,
      is_enabled: p.is_enabled,
      config: JSON.stringify(p.config ?? {}, null, 2),
    })
    setFormError(null)
    setFormOpen(true)
  }

  async function submitForm() {
    if (!workspaceId) return
    if (!form.name.trim()) {
      setFormError('Name is required.')
      return
    }
    let parsedConfig: unknown = {}
    if (form.config.trim()) {
      try {
        parsedConfig = JSON.parse(form.config)
      } catch {
        setFormError('Config must be valid JSON.')
        return
      }
    }
    setBusy(true)
    setFormError(null)
    try {
      const body = {
        workspace_id: workspaceId,
        name: form.name.trim(),
        rule_type: form.rule_type,
        severity: form.severity,
        is_enabled: form.is_enabled,
        config: parsedConfig,
      }
      if (editing) {
        const updated: Policy = await api.updatePolicy(editing.id, body)
        setPolicies((prev) => prev.map((p) => (p.id === editing.id ? { ...p, ...updated } : p)))
        flash('Policy updated.')
      } else {
        const created: Policy = await api.createPolicy(body)
        setPolicies((prev) => [created, ...prev])
        flash('Policy created.')
      }
      setFormOpen(false)
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function toggleEnabled(p: Policy) {
    setBusy(true)
    setError(null)
    try {
      const updated: Policy = await api.updatePolicy(p.id, { is_enabled: !p.is_enabled })
      setPolicies((prev) => prev.map((x) => (x.id === p.id ? { ...x, ...updated } : x)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toggle failed')
    } finally {
      setBusy(false)
    }
  }

  async function removePolicy(p: Policy) {
    if (!confirm(`Delete policy "${p.name}"? This also removes its violations.`)) return
    setBusy(true)
    setError(null)
    try {
      await api.deletePolicy(p.id)
      setPolicies((prev) => prev.filter((x) => x.id !== p.id))
      if (viewPolicy?.id === p.id) setViewPolicy(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  async function evaluate() {
    if (!workspaceId) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.evaluatePolicies({ workspace_id: workspaceId })
      flash(`Evaluation complete — ${res?.violations ?? 0} violation(s) recorded.`)
      if (viewPolicy) await loadViolations(viewPolicy)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Evaluation failed')
    } finally {
      setBusy(false)
    }
  }

  async function loadViolations(p: Policy) {
    setViewPolicy(p)
    setViolationsLoading(true)
    setViolations([])
    try {
      const list: PolicyViolation[] = await api.getPolicyViolations(p.id)
      setViolations(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load violations')
    } finally {
      setViolationsLoading(false)
    }
  }

  async function exempt(v: PolicyViolation) {
    const reason = prompt('Exemption reason:')
    if (reason == null) return
    setBusy(true)
    setError(null)
    try {
      const updated: PolicyViolation = await api.exemptViolation(v.id, { exemption_reason: reason })
      setViolations((prev) => prev.map((x) => (x.id === v.id ? { ...x, ...updated } : x)))
      flash('Violation exempted.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Exempt failed')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner label="Loading policies..." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100">Policy Engine</h1>
          <p className="mt-1 text-sm text-slate-500">
            Codify your CI/CD security guardrails, evaluate them against every pipeline, and exempt accepted risk.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={evaluate} disabled={busy || !workspaceId}>
            {busy ? <Spinner /> : 'Evaluate all'}
          </Button>
          <Button variant="primary" onClick={openCreate} disabled={!workspaceId}>
            New policy
          </Button>
        </div>
      </div>

      {banner && (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
          {banner}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {!workspaceId ? (
        <EmptyState
          title="No workspace found"
          description="Seed sample data from the dashboard to populate policies."
        />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Policies" value={stats.total} />
            <Stat label="Enabled" value={stats.enabled} accent="emerald" />
            <Stat label="Disabled" value={stats.disabled} />
          </div>

          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle>Policies</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search policies..."
                  className="w-56 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-red-600 focus:outline-none"
                />
                <select
                  value={severityFilter}
                  onChange={(e) => setSeverityFilter(e.target.value)}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 focus:border-red-600 focus:outline-none"
                >
                  <option value="all">All severities</option>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s[0].toUpperCase() + s.slice(1)}
                    </option>
                  ))}
                </select>
                <select
                  value={enabledFilter}
                  onChange={(e) => setEnabledFilter(e.target.value)}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 focus:border-red-600 focus:outline-none"
                >
                  <option value="all">All</option>
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </select>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              {filtered.length === 0 ? (
                <div className="px-5 py-10">
                  <EmptyState
                    title="No policies"
                    description="Create a policy to start enforcing CI/CD security guardrails."
                    action={
                      <Button variant="primary" onClick={openCreate}>
                        New policy
                      </Button>
                    }
                  />
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Name</TH>
                      <TH>Rule</TH>
                      <TH>Severity</TH>
                      <TH>Status</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {filtered.map((p) => (
                      <TR key={p.id}>
                        <TD>
                          <button
                            onClick={() => loadViolations(p)}
                            className="text-left font-medium text-slate-100 hover:text-red-300"
                          >
                            {p.name}
                          </button>
                        </TD>
                        <TD>
                          <span className="text-xs text-slate-400">{fmtRule(p.rule_type)}</span>
                        </TD>
                        <TD>
                          <Badge tone={severityTone(p.severity)}>{p.severity}</Badge>
                        </TD>
                        <TD>
                          <Badge tone={p.is_enabled ? 'success' : 'neutral'}>
                            {p.is_enabled ? 'enabled' : 'disabled'}
                          </Badge>
                        </TD>
                        <TD>
                          <div className="flex justify-end gap-1.5">
                            <Button size="sm" variant="ghost" onClick={() => loadViolations(p)}>
                              Violations
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => toggleEnabled(p)} disabled={busy}>
                              {p.is_enabled ? 'Disable' : 'Enable'}
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => openEdit(p)} disabled={busy}>
                              Edit
                            </Button>
                            <Button size="sm" variant="danger" onClick={() => removePolicy(p)} disabled={busy}>
                              Delete
                            </Button>
                          </div>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>

          {viewPolicy && (
            <Card>
              <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle>Violations · {viewPolicy.name}</CardTitle>
                  <p className="mt-1 text-xs text-slate-500">{fmtRule(viewPolicy.rule_type)}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={evaluate} disabled={busy}>
                    Re-evaluate
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setViewPolicy(null)}>
                    Close
                  </Button>
                </div>
              </CardHeader>
              <CardBody className="p-0">
                {violationsLoading ? (
                  <div className="flex justify-center py-10">
                    <Spinner label="Loading violations..." />
                  </div>
                ) : violations.length === 0 ? (
                  <div className="px-5 py-10">
                    <EmptyState
                      title="No violations"
                      description="This policy is passing, or it has not been evaluated yet. Run an evaluation to refresh."
                      action={
                        <Button variant="primary" onClick={evaluate} disabled={busy}>
                          Evaluate now
                        </Button>
                      }
                    />
                  </div>
                ) : (
                  <Table>
                    <THead>
                      <TR>
                        <TH>Status</TH>
                        <TH>Detail</TH>
                        <TH>Pipeline</TH>
                        <TH>Evaluated</TH>
                        <TH className="text-right">Actions</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {violations.map((v) => (
                        <TR key={v.id}>
                          <TD>
                            <Badge tone={violationTone(v.status)}>{v.status}</Badge>
                          </TD>
                          <TD>
                            <div className="max-w-md text-slate-300">{v.detail || '—'}</div>
                            {v.exemption_reason && (
                              <div className="mt-0.5 text-xs text-slate-500">Exempt: {v.exemption_reason}</div>
                            )}
                          </TD>
                          <TD className="font-mono text-xs text-slate-400">
                            {v.pipeline_id ? v.pipeline_id.slice(0, 8) : '—'}
                          </TD>
                          <TD className="text-slate-400">{fmtDate(v.evaluated_at)}</TD>
                          <TD>
                            <div className="flex justify-end">
                              {v.status !== 'exempted' ? (
                                <Button size="sm" variant="secondary" onClick={() => exempt(v)} disabled={busy}>
                                  Exempt
                                </Button>
                              ) : (
                                <span className="text-xs text-slate-600">exempted</span>
                              )}
                            </div>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </CardBody>
            </Card>
          )}
        </>
      )}

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Edit policy' : 'New policy'}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submitForm} disabled={busy}>
              {busy ? <Spinner /> : editing ? 'Save changes' : 'Create policy'}
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          {formError && (
            <div className="rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {formError}
            </div>
          )}
          <div>
            <label className="text-xs uppercase tracking-wide text-slate-500">Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Require OIDC for all deploys"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-red-600 focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs uppercase tracking-wide text-slate-500">Rule type</label>
              <select
                value={form.rule_type}
                onChange={(e) => setForm((f) => ({ ...f, rule_type: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 focus:border-red-600 focus:outline-none"
              >
                {RULE_TYPES.map((r) => (
                  <option key={r} value={r}>
                    {fmtRule(r)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs uppercase tracking-wide text-slate-500">Severity</label>
              <select
                value={form.severity}
                onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 focus:border-red-600 focus:outline-none"
              >
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s[0].toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wide text-slate-500">Config (JSON)</label>
            <textarea
              value={form.config}
              onChange={(e) => setForm((f) => ({ ...f, config: e.target.value }))}
              rows={5}
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 focus:border-red-600 focus:outline-none"
            />
            <p className="mt-1 text-xs text-slate-600">Rule-specific options, e.g. {`{ "max_age_days": 90 }`}</p>
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.is_enabled}
              onChange={(e) => setForm((f) => ({ ...f, is_enabled: e.target.checked }))}
              className="h-4 w-4 cursor-pointer accent-red-600"
            />
            <span className="text-slate-300">Enabled</span>
          </label>
        </div>
      </Modal>
    </div>
  )
}
