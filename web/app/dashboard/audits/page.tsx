'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'
import { Badge, severityTone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Stat } from '@/components/ui/Stat'

interface Workspace {
  id: string
  name: string
}

interface AuditSummary {
  pipelines?: number
  findings?: number
  violations?: number
  snapshot_id?: string
  severity?: Record<string, number>
  risk_score?: number
  [k: string]: unknown
}

interface Audit {
  id: string
  workspace_id: string
  name: string
  schedule?: string | null
  status?: string | null
  last_run_at?: string | null
  summary?: AuditSummary | null
  created_by?: string | null
  created_at?: string
}

const SCHEDULES = [
  { value: 'manual', label: 'Manual (on demand)' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
]

function statusTone(status?: string | null): 'success' | 'critical' | 'warning' | 'neutral' | 'info' {
  switch ((status ?? '').toLowerCase()) {
    case 'passed':
    case 'clean':
    case 'completed':
    case 'ok':
      return 'success'
    case 'failed':
    case 'error':
      return 'critical'
    case 'running':
    case 'pending':
    case 'scheduled':
      return 'warning'
    case 'findings':
    case 'attention':
      return 'info'
    default:
      return 'neutral'
  }
}

function fmtDate(s?: string | null): string {
  if (!s) return 'Never'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return String(s)
  return d.toLocaleString()
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

export default function AuditsPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [audits, setAudits] = useState<Audit[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [scheduleFilter, setScheduleFilter] = useState('all')

  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ name: '', schedule: 'daily' })

  const [detail, setDetail] = useState<Audit | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const loadScoped = useCallback(async (wsId: string) => {
    const list = await api.listAudits(wsId)
    setAudits(Array.isArray(list) ? list : [])
  }, [])

  const init = useCallback(async () => {
    setLoading(true)
    try {
      setError(null)
      const ws: Workspace[] = (await api.listWorkspaces()) ?? []
      setWorkspaces(ws)
      if (ws.length > 0) {
        setWorkspaceId(ws[0].id)
        await loadScoped(ws[0].id)
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load audits')
    } finally {
      setLoading(false)
    }
  }, [loadScoped])

  useEffect(() => {
    init()
  }, [init])

  const refresh = async () => {
    if (!workspaceId) return
    setLoading(true)
    try {
      setError(null)
      await loadScoped(workspaceId)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to refresh')
    } finally {
      setLoading(false)
    }
  }

  const onSelectWorkspace = async (id: string) => {
    setWorkspaceId(id)
    setLoading(true)
    try {
      await loadScoped(id)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  const openCreate = () => {
    setForm({ name: '', schedule: 'daily' })
    setCreateOpen(true)
  }

  const saveAudit = async () => {
    if (!form.name.trim()) {
      setError('Audit name is required')
      return
    }
    setBusy('create')
    setError(null)
    try {
      await api.createAudit({
        workspace_id: workspaceId,
        name: form.name.trim(),
        schedule: form.schedule,
      })
      setCreateOpen(false)
      await loadScoped(workspaceId)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to create audit')
    } finally {
      setBusy(null)
    }
  }

  const runAudit = async (a: Audit) => {
    setBusy(`run-${a.id}`)
    setError(null)
    try {
      const updated = await api.runAudit(a.id)
      await loadScoped(workspaceId)
      if (detail?.id === a.id && updated) setDetail(updated)
    } catch (e: any) {
      setError(e?.message ?? 'Audit run failed')
    } finally {
      setBusy(null)
    }
  }

  const removeAudit = async (a: Audit) => {
    if (!confirm(`Delete audit "${a.name}"? Its run history will be removed.`)) return
    setBusy(`del-${a.id}`)
    setError(null)
    try {
      await api.deleteAudit(a.id)
      if (detail?.id === a.id) setDetail(null)
      await loadScoped(workspaceId)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to delete audit')
    } finally {
      setBusy(null)
    }
  }

  const openDetail = async (a: Audit) => {
    setDetail(a)
    setDetailLoading(true)
    try {
      const full = await api.getAudit(a.id)
      if (full) setDetail(full)
    } catch {
      // keep the row data we already have
    } finally {
      setDetailLoading(false)
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return audits.filter((a) => {
      if (scheduleFilter !== 'all' && (a.schedule ?? 'manual') !== scheduleFilter) return false
      if (!q) return true
      return (
        a.name.toLowerCase().includes(q) ||
        (a.schedule ?? '').toLowerCase().includes(q) ||
        (a.status ?? '').toLowerCase().includes(q)
      )
    })
  }, [audits, search, scheduleFilter])

  const stats = useMemo(() => {
    const total = audits.length
    const scheduled = audits.filter((a) => (a.schedule ?? 'manual') !== 'manual').length
    const everRun = audits.filter((a) => a.last_run_at).length
    let totalFindings = 0
    for (const a of audits) totalFindings += num(a.summary?.findings)
    return { total, scheduled, everRun, totalFindings }
  }, [audits])

  const isEmpty = workspaces.length === 0

  if (loading && audits.length === 0 && !isEmpty) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner label="Loading audits..." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-100">Scheduled Audits</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Recurring posture audits that snapshot, evaluate policies, and scan findings — with full run history.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {workspaces.length > 1 && (
            <select
              value={workspaceId}
              onChange={(e) => onSelectWorkspace(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-red-500/60"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {isEmpty ? (
        <EmptyState
          title="No workspace"
          description="Create or seed a workspace from the dashboard before configuring audits."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Audits" value={stats.total} />
            <Stat label="Scheduled" value={stats.scheduled} accent="sky" />
            <Stat label="Ever run" value={stats.everRun} accent="emerald" />
            <Stat label="Findings (last runs)" value={stats.totalFindings} accent={stats.totalFindings > 0 ? 'red' : 'emerald'} />
          </div>

          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Audits & Run History</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search audits..."
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-500/60"
                />
                <select
                  value={scheduleFilter}
                  onChange={(e) => setScheduleFilter(e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-red-500/60"
                >
                  <option value="all">All schedules</option>
                  {SCHEDULES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="secondary" onClick={refresh} disabled={loading}>
                  Refresh
                </Button>
                <Button size="sm" onClick={openCreate}>
                  New audit
                </Button>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              {filtered.length === 0 ? (
                <div className="p-6">
                  <EmptyState
                    title={audits.length === 0 ? 'No audits' : 'No matching audits'}
                    description={
                      audits.length === 0
                        ? 'Create a scheduled audit to continuously snapshot posture, evaluate policies, and scan for findings.'
                        : 'Adjust your search or schedule filter.'
                    }
                    action={audits.length === 0 ? <Button onClick={openCreate}>New audit</Button> : undefined}
                  />
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Name</TH>
                      <TH>Schedule</TH>
                      <TH>Status</TH>
                      <TH>Last run</TH>
                      <TH>Findings</TH>
                      <TH>Violations</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {filtered.map((a) => {
                      const findings = num(a.summary?.findings)
                      const violations = num(a.summary?.violations)
                      return (
                        <TR key={a.id} className="cursor-pointer" onClick={() => openDetail(a)}>
                          <TD className="font-medium text-zinc-100">{a.name}</TD>
                          <TD>
                            <Badge tone="info">{a.schedule || 'manual'}</Badge>
                          </TD>
                          <TD>
                            <Badge tone={statusTone(a.status)}>{a.status || 'idle'}</Badge>
                          </TD>
                          <TD className="text-zinc-500">{fmtDate(a.last_run_at)}</TD>
                          <TD className={findings > 0 ? 'text-red-400' : 'text-zinc-500'}>{a.last_run_at ? findings : '—'}</TD>
                          <TD className={violations > 0 ? 'text-amber-400' : 'text-zinc-500'}>
                            {a.last_run_at ? violations : '—'}
                          </TD>
                          <TD className="text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex justify-end gap-2">
                              <Button size="sm" onClick={() => runAudit(a)} disabled={busy === `run-${a.id}`}>
                                {busy === `run-${a.id}` ? 'Running...' : 'Run now'}
                              </Button>
                              <Button size="sm" variant="secondary" onClick={() => openDetail(a)}>
                                View
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => removeAudit(a)}
                                disabled={busy === `del-${a.id}`}
                              >
                                Delete
                              </Button>
                            </div>
                          </TD>
                        </TR>
                      )
                    })}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>
        </>
      )}

      {/* Create modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New scheduled audit"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveAudit} disabled={busy === 'create'}>
              {busy === 'create' ? 'Creating...' : 'Create audit'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name">
            <TextInput
              value={form.name}
              onChange={(v) => setForm({ ...form, name: v })}
              placeholder="Weekly SOC2 posture audit"
            />
          </Field>
          <Field label="Schedule">
            <select
              value={form.schedule}
              onChange={(e) => setForm({ ...form, schedule: e.target.value })}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-500/60"
            >
              {SCHEDULES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-xs text-zinc-500">
            Running an audit captures a snapshot, evaluates all enabled policies, and runs the finding detectors. The
            summary below records the result of each run.
          </p>
        </div>
      </Modal>

      {/* Detail modal */}
      <Modal
        open={detail != null}
        onClose={() => setDetail(null)}
        title={detail ? `Audit · ${detail.name}` : 'Audit'}
        size="lg"
        footer={
          detail ? (
            <>
              <Button variant="ghost" onClick={() => setDetail(null)}>
                Close
              </Button>
              <Button onClick={() => runAudit(detail)} disabled={busy === `run-${detail.id}`}>
                {busy === `run-${detail.id}` ? 'Running...' : 'Run now'}
              </Button>
            </>
          ) : undefined
        }
      >
        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="info">{detail.schedule || 'manual'}</Badge>
              <Badge tone={statusTone(detail.status)}>{detail.status || 'idle'}</Badge>
              <span className="text-xs text-zinc-500">Last run: {fmtDate(detail.last_run_at)}</span>
              {detailLoading && <Spinner label="Refreshing..." />}
            </div>

            {detail.last_run_at ? (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <Stat label="Pipelines" value={num(detail.summary?.pipelines)} />
                  <Stat
                    label="Findings"
                    value={num(detail.summary?.findings)}
                    accent={num(detail.summary?.findings) > 0 ? 'red' : 'emerald'}
                  />
                  <Stat
                    label="Violations"
                    value={num(detail.summary?.violations)}
                    accent={num(detail.summary?.violations) > 0 ? 'amber' : 'emerald'}
                  />
                </div>

                {detail.summary?.severity && Object.keys(detail.summary.severity).length > 0 && (
                  <div>
                    <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Findings by severity
                    </div>
                    <SeverityBars severity={detail.summary.severity} />
                  </div>
                )}

                {typeof detail.summary?.risk_score === 'number' && (
                  <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-sm text-zinc-300">
                    Avg risk score at run: <span className="font-semibold text-red-400">{detail.summary.risk_score}</span>
                  </div>
                )}

                <details className="rounded-lg border border-zinc-800 bg-zinc-950/60">
                  <summary className="cursor-pointer px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Raw summary
                  </summary>
                  <pre className="max-h-64 overflow-auto px-4 py-3 text-xs text-zinc-400">
                    {JSON.stringify(detail.summary ?? {}, null, 2)}
                  </pre>
                </details>
              </>
            ) : (
              <EmptyState
                title="Never run"
                description="This audit has no run history yet. Run it now to capture a snapshot and scan for findings."
                action={
                  <Button onClick={() => runAudit(detail)} disabled={busy === `run-${detail.id}`}>
                    {busy === `run-${detail.id}` ? 'Running...' : 'Run now'}
                  </Button>
                }
              />
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

function SeverityBars({ severity }: { severity: Record<string, number> }) {
  const order = ['critical', 'high', 'medium', 'low']
  const entries = order
    .filter((k) => k in severity)
    .map((k) => [k, num(severity[k])] as const)
  const extra = Object.keys(severity)
    .filter((k) => !order.includes(k))
    .map((k) => [k, num(severity[k])] as const)
  const all = [...entries, ...extra]
  const max = Math.max(1, ...all.map(([, v]) => v))
  return (
    <div className="space-y-2">
      {all.map(([k, v]) => (
        <div key={k} className="flex items-center gap-3">
          <div className="w-20 shrink-0">
            <Badge tone={severityTone(k)}>{k}</Badge>
          </div>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-red-500"
              style={{ width: `${(v / max) * 100}%` }}
            />
          </div>
          <div className="w-8 shrink-0 text-right text-sm tabular-nums text-zinc-300">{v}</div>
        </div>
      ))}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </label>
  )
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-500/60"
    />
  )
}
