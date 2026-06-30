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
  created_at: string
  updated_at: string
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

export default function OverPrivilegePage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [findings, setFindings] = useState<Finding[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

  const [severityFilter, setSeverityFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<Finding | null>(null)

  async function loadFindings(wsId: string) {
    const all: Finding[] = await api.listFindings(wsId)
    // This page is the over-privilege view; scope to the over_privilege detector.
    setFindings(all.filter((f) => f.detector === 'over_privilege'))
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

  const stats = useMemo(() => {
    const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 }
    let open = 0
    for (const f of findings) {
      const sev = f.severity?.toLowerCase()
      if (sev in counts) counts[sev] += 1
      if (f.status === 'open') open += 1
    }
    return { counts, open, total: findings.length }
  }, [findings])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return findings
      .filter((f) => severityFilter === 'all' || f.severity?.toLowerCase() === severityFilter)
      .filter((f) => statusFilter === 'all' || f.status === statusFilter)
      .filter(
        (f) =>
          !q ||
          f.title.toLowerCase().includes(q) ||
          (f.description ?? '').toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const sa = SEVERITY_ORDER.indexOf(a.severity?.toLowerCase())
        const sb = SEVERITY_ORDER.indexOf(b.severity?.toLowerCase())
        return (sa === -1 ? 99 : sa) - (sb === -1 ? 99 : sb)
      })
  }, [findings, severityFilter, statusFilter, search])

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

  async function genRecs() {
    if (!workspaceId) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.generateRecommendations({ workspace_id: workspaceId })
      flash(`Generated ${res?.created ?? 0} least-privilege recommendation(s). View them in Recommendations.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate recommendations')
    } finally {
      setBusy(false)
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

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner label="Loading over-privilege findings..." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-100">Over-Privilege</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Pipelines whose effective privilege exceeds declared need, with least-privilege remediation.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={genRecs} disabled={busy || !workspaceId}>
            Generate recommendations
          </Button>
          <Button variant="primary" onClick={runScan} disabled={busy || !workspaceId}>
            {busy ? <Spinner /> : 'Re-scan'}
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
          description="Seed sample data from the dashboard to populate over-privilege findings."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Total" value={stats.total} />
            <Stat label="Open" value={stats.open} accent="red" />
            <Stat label="Critical" value={stats.counts.critical} accent="red" />
            <Stat label="High" value={stats.counts.high} accent="amber" />
            <Stat label="Medium" value={stats.counts.medium} accent="amber" />
          </div>

          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle>Findings</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search title or description..."
                  className="w-56 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-red-600 focus:outline-none"
                />
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
            </CardHeader>
            <CardBody className="p-0">
              {filtered.length === 0 ? (
                <div className="px-5 py-10">
                  <EmptyState
                    title="No over-privilege findings"
                    description="Run a re-scan to detect pipelines that hold more privilege than they declare."
                    action={
                      <Button variant="primary" onClick={runScan} disabled={busy}>
                        Re-scan now
                      </Button>
                    }
                  />
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Severity</TH>
                      <TH>Title</TH>
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
                          <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
                        </TD>
                        <TD>
                          <button
                            onClick={() => setDetail(f)}
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
                                Acknowledge
                              </Button>
                            )}
                            {f.status !== 'resolved' && (
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => patchFinding(f.id, { status: 'resolved' })}
                                disabled={busy}
                              >
                                Remediate
                              </Button>
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
              <Button
                variant="secondary"
                onClick={() => patchFinding(detail.id, { status: 'suppressed', suppress_reason: 'Reviewed — accepted risk' })}
                disabled={busy}
              >
                Suppress
              </Button>
              <Button
                variant="primary"
                onClick={() => patchFinding(detail.id, { status: 'resolved' })}
                disabled={busy}
              >
                Mark remediated
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
              <Badge tone="neutral">{detail.detector}</Badge>
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
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (v !== (detail.assignee || '')) patchFinding(detail.id, { assignee: v })
                  }}
                  placeholder="unassigned"
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-red-600 focus:outline-none"
                />
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-500">Created</div>
                <div className="mt-1 py-1.5 text-zinc-400">{fmtDate(detail.created_at)}</div>
              </div>
            </div>

            {detail.evidence != null && (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Evidence</div>
                <pre className="max-h-64 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-400">
                  {JSON.stringify(detail.evidence, null, 2)}
                </pre>
              </div>
            )}

            <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-3 text-xs text-red-200/80">
              Least-privilege fix: use <span className="font-semibold">Generate recommendations</span> on this page to
              produce the exact YAML / trust-policy diff that closes this gap, then apply it from the Recommendations
              center.
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
