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

interface Finding {
  id: string
  workspace_id: string
  pipeline_id: string | null
  detector: string
  title: string
  description: string | null
  severity: string
  status: string
  evidence: unknown
  assignee: string | null
  due_date: string | null
  suppress_reason: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

interface Recommendation {
  id: string
  finding_id: string | null
  kind: string
  title: string
  detail: string | null
  suggested_diff: string | null
  risk_delta: number | null
  status: string
}

interface FindingDetail extends Finding {
  recommendations?: Recommendation[]
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low']
const STATUS_OPTIONS = ['open', 'acknowledged', 'in_progress', 'resolved', 'suppressed']

function statusTone(status: string): 'neutral' | 'success' | 'warning' | 'info' {
  switch (status) {
    case 'resolved':
      return 'success'
    case 'in_progress':
    case 'acknowledged':
      return 'warning'
    case 'suppressed':
      return 'neutral'
    default:
      return 'info'
  }
}

function fmtDate(s?: string | null) {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString()
}

function fmtDetector(d: string) {
  return d.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export default function FindingsPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [findings, setFindings] = useState<Finding[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

  const [severityFilter, setSeverityFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [detectorFilter, setDetectorFilter] = useState('all')
  const [search, setSearch] = useState('')

  const [detail, setDetail] = useState<FindingDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  async function loadFindings(wsId: string) {
    const all: Finding[] = await api.listFindings(wsId)
    setFindings(all)
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
        await loadFindings(wsId)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load findings')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const detectors = useMemo(() => {
    const set = new Set<string>()
    for (const f of findings) if (f.detector) set.add(f.detector)
    return Array.from(set).sort()
  }, [findings])

  const stats = useMemo(() => {
    const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 }
    let open = 0
    let resolved = 0
    for (const f of findings) {
      const sev = f.severity?.toLowerCase()
      if (sev in counts) counts[sev] += 1
      if (f.status === 'open') open += 1
      if (f.status === 'resolved') resolved += 1
    }
    return { counts, open, resolved, total: findings.length }
  }, [findings])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return findings
      .filter((f) => severityFilter === 'all' || f.severity?.toLowerCase() === severityFilter)
      .filter((f) => statusFilter === 'all' || f.status === statusFilter)
      .filter((f) => detectorFilter === 'all' || f.detector === detectorFilter)
      .filter(
        (f) =>
          !q ||
          f.title.toLowerCase().includes(q) ||
          (f.description ?? '').toLowerCase().includes(q) ||
          f.detector.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const sa = SEVERITY_ORDER.indexOf(a.severity?.toLowerCase())
        const sb = SEVERITY_ORDER.indexOf(b.severity?.toLowerCase())
        return (sa === -1 ? 99 : sa) - (sb === -1 ? 99 : sb)
      })
  }, [findings, severityFilter, statusFilter, detectorFilter, search])

  function flash(msg: string) {
    setBanner(msg)
    setTimeout(() => setBanner(null), 4000)
  }

  async function runScan() {
    if (!workspaceId) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.scanFindings({ workspace_id: workspaceId })
      await loadFindings(workspaceId)
      flash(`Scan complete — ${res?.created ?? 0} finding(s) upserted.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed')
    } finally {
      setBusy(false)
    }
  }

  async function openDetail(f: Finding) {
    setDetail(f)
    setDetailLoading(true)
    try {
      const full: FindingDetail = await api.getFinding(f.id)
      setDetail(full)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load finding detail')
    } finally {
      setDetailLoading(false)
    }
  }

  async function patchFinding(id: string, body: Partial<Finding>) {
    if (!workspaceId) return
    setBusy(true)
    setError(null)
    try {
      const updated: Finding = await api.updateFinding(id, body)
      setFindings((prev) => prev.map((f) => (f.id === id ? { ...f, ...updated } : f)))
      setDetail((d) => (d && d.id === id ? { ...d, ...updated } : d))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setBusy(false)
    }
  }

  async function removeFinding(id: string) {
    if (!workspaceId) return
    if (!confirm('Delete this finding permanently?')) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteFinding(id)
      setFindings((prev) => prev.filter((f) => f.id !== id))
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      setDetail((d) => (d && d.id === id ? null : d))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected((prev) => {
      if (prev.size === filtered.length && filtered.length > 0) return new Set()
      return new Set(filtered.map((f) => f.id))
    })
  }

  async function bulkStatus(status: string) {
    const ids = Array.from(selected)
    if (!ids.length) return
    setBusy(true)
    setError(null)
    try {
      const updates = await Promise.all(ids.map((id) => api.updateFinding(id, { status })))
      const byId = new Map<string, Finding>(updates.map((u: Finding) => [u.id, u]))
      setFindings((prev) => prev.map((f) => (byId.has(f.id) ? { ...f, ...byId.get(f.id)! } : f)))
      flash(`Updated ${ids.length} finding(s) to "${status.replace('_', ' ')}".`)
      setSelected(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bulk update failed')
    } finally {
      setBusy(false)
    }
  }

  async function bulkDelete() {
    const ids = Array.from(selected)
    if (!ids.length) return
    if (!confirm(`Delete ${ids.length} finding(s) permanently?`)) return
    setBusy(true)
    setError(null)
    try {
      await Promise.all(ids.map((id) => api.deleteFinding(id)))
      const idSet = new Set(ids)
      setFindings((prev) => prev.filter((f) => !idSet.has(f.id)))
      flash(`Deleted ${ids.length} finding(s).`)
      setSelected(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bulk delete failed')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner label="Loading findings..." />
      </div>
    )
  }

  const allChecked = filtered.length > 0 && selected.size === filtered.length

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-100">Findings</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Unified security findings across every detector — triage, assign, and drive the status workflow.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={runScan} disabled={busy || !workspaceId}>
            {busy ? <Spinner /> : 'Run scan'}
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
          description="Seed sample data from the dashboard to populate findings."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
            <Stat label="Total" value={stats.total} />
            <Stat label="Open" value={stats.open} accent="red" />
            <Stat label="Critical" value={stats.counts.critical} accent="red" />
            <Stat label="High" value={stats.counts.high} accent="amber" />
            <Stat label="Medium" value={stats.counts.medium} accent="amber" />
            <Stat label="Resolved" value={stats.resolved} accent="emerald" />
          </div>

          <Card>
            <CardHeader className="flex flex-col gap-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <CardTitle>All findings</CardTitle>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search title, detector, description..."
                    className="w-64 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-red-600 focus:outline-none"
                  />
                  <select
                    value={detectorFilter}
                    onChange={(e) => setDetectorFilter(e.target.value)}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:border-red-600 focus:outline-none"
                  >
                    <option value="all">All detectors</option>
                    {detectors.map((d) => (
                      <option key={d} value={d}>
                        {fmtDetector(d)}
                      </option>
                    ))}
                  </select>
                  <select
                    value={severityFilter}
                    onChange={(e) => setSeverityFilter(e.target.value)}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:border-red-600 focus:outline-none"
                  >
                    <option value="all">All severities</option>
                    {SEVERITY_ORDER.map((s) => (
                      <option key={s} value={s}>
                        {s[0].toUpperCase() + s.slice(1)}
                      </option>
                    ))}
                  </select>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:border-red-600 focus:outline-none"
                  >
                    <option value="all">All statuses</option>
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {selected.size > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                  <span className="text-xs text-zinc-400">{selected.size} selected</span>
                  <Button size="sm" variant="secondary" onClick={() => bulkStatus('acknowledged')} disabled={busy}>
                    Acknowledge
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => bulkStatus('in_progress')} disabled={busy}>
                    In progress
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => bulkStatus('resolved')} disabled={busy}>
                    Resolve
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => bulkStatus('suppressed')} disabled={busy}>
                    Suppress
                  </Button>
                  <Button size="sm" variant="danger" onClick={bulkDelete} disabled={busy}>
                    Delete
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={busy}>
                    Clear
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardBody className="p-0">
              {filtered.length === 0 ? (
                <div className="px-5 py-10">
                  <EmptyState
                    title="No findings match"
                    description="Adjust filters or run a scan to detect issues across your pipelines."
                    action={
                      <Button variant="primary" onClick={runScan} disabled={busy}>
                        Run scan
                      </Button>
                    }
                  />
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH className="w-8">
                        <input
                          type="checkbox"
                          checked={allChecked}
                          onChange={toggleAll}
                          className="h-4 w-4 cursor-pointer accent-red-600"
                          aria-label="Select all"
                        />
                      </TH>
                      <TH>Severity</TH>
                      <TH>Title</TH>
                      <TH>Detector</TH>
                      <TH>Status</TH>
                      <TH>Assignee</TH>
                      <TH>Due</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {filtered.map((f) => (
                      <TR key={f.id}>
                        <TD>
                          <input
                            type="checkbox"
                            checked={selected.has(f.id)}
                            onChange={() => toggleRow(f.id)}
                            className="h-4 w-4 cursor-pointer accent-red-600"
                            aria-label={`Select ${f.title}`}
                          />
                        </TD>
                        <TD>
                          <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
                        </TD>
                        <TD>
                          <button
                            onClick={() => openDetail(f)}
                            className="text-left font-medium text-zinc-100 hover:text-red-300"
                          >
                            {f.title}
                          </button>
                          {f.description && (
                            <div className="mt-0.5 line-clamp-1 max-w-md text-xs text-zinc-500">
                              {f.description}
                            </div>
                          )}
                        </TD>
                        <TD>
                          <span className="text-xs text-zinc-400">{fmtDetector(f.detector)}</span>
                        </TD>
                        <TD>
                          <Badge tone={statusTone(f.status)}>{f.status.replace('_', ' ')}</Badge>
                        </TD>
                        <TD className="text-zinc-400">{f.assignee || '—'}</TD>
                        <TD className="text-zinc-400">{fmtDate(f.due_date)}</TD>
                        <TD>
                          <div className="flex justify-end gap-1.5">
                            {f.status !== 'acknowledged' && f.status !== 'resolved' && (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => patchFinding(f.id, { status: 'acknowledged' })}
                                disabled={busy}
                              >
                                Ack
                              </Button>
                            )}
                            {f.status !== 'resolved' && (
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => patchFinding(f.id, { status: 'resolved' })}
                                disabled={busy}
                              >
                                Resolve
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => removeFinding(f.id)}
                              disabled={busy}
                            >
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
        </>
      )}

      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.title}
        size="lg"
        footer={
          detail && (
            <>
              <Button variant="ghost" onClick={() => setDetail(null)}>
                Close
              </Button>
              <Button variant="danger" onClick={() => removeFinding(detail.id)} disabled={busy}>
                Delete
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  patchFinding(detail.id, { status: 'suppressed', suppress_reason: 'Reviewed — accepted risk' })
                }
                disabled={busy}
              >
                Suppress
              </Button>
              <Button variant="primary" onClick={() => patchFinding(detail.id, { status: 'resolved' })} disabled={busy}>
                Mark resolved
              </Button>
            </>
          )
        }
      >
        {detail && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={severityTone(detail.severity)}>{detail.severity}</Badge>
              <Badge tone={statusTone(detail.status)}>{detail.status.replace('_', ' ')}</Badge>
              <Badge tone="neutral">{fmtDetector(detail.detector)}</Badge>
              {detailLoading && <Spinner />}
            </div>
            {detail.description && <p className="text-zinc-300">{detail.description}</p>}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-500">Status</div>
                <select
                  value={detail.status}
                  onChange={(e) => patchFinding(detail.id, { status: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:border-red-600 focus:outline-none"
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-500">Severity</div>
                <select
                  value={detail.severity}
                  onChange={(e) => patchFinding(detail.id, { severity: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:border-red-600 focus:outline-none"
                >
                  {SEVERITY_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {s[0].toUpperCase() + s.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-500">Assignee</div>
                <input
                  defaultValue={detail.assignee || ''}
                  key={`assignee-${detail.id}`}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (v !== (detail.assignee || '')) patchFinding(detail.id, { assignee: v })
                  }}
                  placeholder="unassigned"
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-red-600 focus:outline-none"
                />
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-500">Due date</div>
                <input
                  type="date"
                  defaultValue={detail.due_date ? detail.due_date.slice(0, 10) : ''}
                  key={`due-${detail.id}`}
                  onBlur={(e) => {
                    const v = e.target.value
                    if (v !== (detail.due_date ? detail.due_date.slice(0, 10) : ''))
                      patchFinding(detail.id, { due_date: v || null })
                  }}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:border-red-600 focus:outline-none"
                />
              </div>
            </div>

            {detail.status === 'suppressed' && (
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-500">Suppress reason</div>
                <input
                  defaultValue={detail.suppress_reason || ''}
                  key={`suppress-${detail.id}`}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (v !== (detail.suppress_reason || '')) patchFinding(detail.id, { suppress_reason: v })
                  }}
                  placeholder="Why is this accepted?"
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-red-600 focus:outline-none"
                />
              </div>
            )}

            {detail.recommendations && detail.recommendations.length > 0 && (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Linked recommendations</div>
                <div className="space-y-2">
                  {detail.recommendations.map((r) => (
                    <div key={r.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-zinc-200">{r.title}</span>
                        <Badge tone={r.status === 'applied' ? 'success' : 'neutral'}>{r.status}</Badge>
                      </div>
                      {r.detail && <p className="mt-1 text-xs text-zinc-400">{r.detail}</p>}
                      {r.suggested_diff && (
                        <pre className="mt-2 max-h-40 overflow-auto rounded border border-zinc-800 bg-black p-2 text-xs text-emerald-300/80">
                          {r.suggested_diff}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {detail.evidence != null && (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Evidence</div>
                <pre className="max-h-64 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-400">
                  {JSON.stringify(detail.evidence, null, 2)}
                </pre>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 text-xs text-zinc-500">
              <div>Created {fmtDate(detail.created_at)}</div>
              <div>Updated {fmtDate(detail.updated_at)}</div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
