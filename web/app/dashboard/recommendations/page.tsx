'use client'

import { useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/Badge'
import { Stat } from '@/components/ui/Stat'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Modal } from '@/components/ui/Modal'

interface Workspace {
  id: string
  name: string
}

interface Recommendation {
  id: string
  workspace_id: string
  pipeline_id: string | null
  finding_id: string | null
  kind: string
  title: string
  detail: string | null
  suggested_diff: string | null
  risk_delta: number | null
  status: string
  applied_by: string | null
  applied_at: string | null
  created_at: string
}

const STATUS_OPTIONS = ['open', 'applied', 'dismissed']

function statusTone(status: string): 'neutral' | 'success' | 'warning' | 'info' {
  switch (status) {
    case 'applied':
      return 'success'
    case 'dismissed':
      return 'neutral'
    default:
      return 'info'
  }
}

function fmtDate(s?: string | null) {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

function fmtKind(k: string) {
  return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function fmtDelta(d: number | null) {
  if (d == null) return '—'
  const sign = d < 0 ? '' : '+'
  return `${sign}${d.toFixed(1)}`
}

// Render a unified-diff style block with colored add/remove lines.
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  return (
    <pre className="max-h-80 overflow-auto rounded-lg border border-zinc-800 bg-black p-3 text-xs leading-relaxed">
      {lines.map((line, i) => {
        let cls = 'text-zinc-400'
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400 bg-emerald-950/30'
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400 bg-red-950/30'
        else if (line.startsWith('@@')) cls = 'text-sky-400'
        else if (line.startsWith('+++') || line.startsWith('---')) cls = 'text-zinc-500'
        return (
          <div key={i} className={`whitespace-pre ${cls}`}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

export default function RecommendationsPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [recs, setRecs] = useState<Recommendation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

  const [statusFilter, setStatusFilter] = useState('all')
  const [kindFilter, setKindFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<Recommendation | null>(null)

  async function loadRecs(wsId: string) {
    const all: Recommendation[] = await api.listRecommendations(wsId)
    setRecs(all)
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
        await loadRecs(wsId)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load recommendations')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const kinds = useMemo(() => {
    const set = new Set<string>()
    for (const r of recs) if (r.kind) set.add(r.kind)
    return Array.from(set).sort()
  }, [recs])

  const stats = useMemo(() => {
    let open = 0
    let applied = 0
    let dismissed = 0
    let totalDelta = 0
    for (const r of recs) {
      if (r.status === 'applied') applied += 1
      else if (r.status === 'dismissed') dismissed += 1
      else open += 1
      if (r.status !== 'dismissed' && r.risk_delta != null) totalDelta += r.risk_delta
    }
    return { open, applied, dismissed, total: recs.length, totalDelta }
  }, [recs])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return recs
      .filter((r) => statusFilter === 'all' || r.status === statusFilter)
      .filter((r) => kindFilter === 'all' || r.kind === kindFilter)
      .filter(
        (r) =>
          !q ||
          r.title.toLowerCase().includes(q) ||
          (r.detail ?? '').toLowerCase().includes(q) ||
          r.kind.toLowerCase().includes(q),
      )
      .sort((a, b) => (a.risk_delta ?? 0) - (b.risk_delta ?? 0))
  }, [recs, statusFilter, kindFilter, search])

  function flash(msg: string) {
    setBanner(msg)
    setTimeout(() => setBanner(null), 4000)
  }

  async function generate() {
    if (!workspaceId) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.generateRecommendations({ workspace_id: workspaceId })
      await loadRecs(workspaceId)
      flash(`Generated ${res?.created ?? 0} recommendation(s) from open findings.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate recommendations')
    } finally {
      setBusy(false)
    }
  }

  async function apply(id: string) {
    setBusy(true)
    setError(null)
    try {
      const updated: Recommendation = await api.applyRecommendation(id)
      setRecs((prev) => prev.map((r) => (r.id === id ? { ...r, ...updated } : r)))
      setDetail((d) => (d && d.id === id ? { ...d, ...updated } : d))
      flash('Recommendation marked applied — evidence captured.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Apply failed')
    } finally {
      setBusy(false)
    }
  }

  async function dismiss(id: string) {
    setBusy(true)
    setError(null)
    try {
      const updated: Recommendation = await api.dismissRecommendation(id)
      setRecs((prev) => prev.map((r) => (r.id === id ? { ...r, ...updated } : r)))
      setDetail((d) => (d && d.id === id ? { ...d, ...updated } : d))
      flash('Recommendation dismissed.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dismiss failed')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner label="Loading recommendations..." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-100">Recommendations</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Least-privilege remediations with ready-to-merge diffs and the risk reduction each one delivers.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={generate} disabled={busy || !workspaceId}>
            {busy ? <Spinner /> : 'Generate from findings'}
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
          description="Seed sample data from the dashboard to populate recommendations."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Total" value={stats.total} />
            <Stat label="Open" value={stats.open} accent="sky" />
            <Stat label="Applied" value={stats.applied} accent="emerald" />
            <Stat label="Dismissed" value={stats.dismissed} />
            <Stat
              label="Pending risk reduction"
              value={fmtDelta(stats.totalDelta)}
              accent={stats.totalDelta < 0 ? 'emerald' : 'default'}
              hint="sum of open + applied deltas"
            />
          </div>

          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle>Suggested remediations</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search recommendations..."
                  className="w-56 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-red-600 focus:outline-none"
                />
                <select
                  value={kindFilter}
                  onChange={(e) => setKindFilter(e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:border-red-600 focus:outline-none"
                >
                  <option value="all">All kinds</option>
                  {kinds.map((k) => (
                    <option key={k} value={k}>
                      {fmtKind(k)}
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
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              {filtered.length === 0 ? (
                <div className="px-5 py-10">
                  <EmptyState
                    title="No recommendations"
                    description="Generate least-privilege recommendations from your open findings to get ready-to-merge diffs."
                    action={
                      <Button variant="primary" onClick={generate} disabled={busy}>
                        Generate from findings
                      </Button>
                    }
                  />
                </div>
              ) : (
                <div className="divide-y divide-zinc-800">
                  {filtered.map((r) => (
                    <div key={r.id} className="px-5 py-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              onClick={() => setDetail(r)}
                              className="text-left font-medium text-zinc-100 hover:text-red-300"
                            >
                              {r.title}
                            </button>
                            <Badge tone="neutral">{fmtKind(r.kind)}</Badge>
                            <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                          </div>
                          {r.detail && <p className="mt-1 max-w-2xl text-sm text-zinc-400">{r.detail}</p>}
                          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
                            <span>
                              Risk delta:{' '}
                              <span className={r.risk_delta != null && r.risk_delta < 0 ? 'text-emerald-400' : 'text-zinc-300'}>
                                {fmtDelta(r.risk_delta)}
                              </span>
                            </span>
                            {r.applied_at && <span>Applied {fmtDate(r.applied_at)}</span>}
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-1.5">
                          <Button size="sm" variant="ghost" onClick={() => setDetail(r)}>
                            View diff
                          </Button>
                          {r.status !== 'applied' && (
                            <Button size="sm" variant="primary" onClick={() => apply(r.id)} disabled={busy}>
                              Apply
                            </Button>
                          )}
                          {r.status !== 'dismissed' && r.status !== 'applied' && (
                            <Button size="sm" variant="secondary" onClick={() => dismiss(r.id)} disabled={busy}>
                              Dismiss
                            </Button>
                          )}
                        </div>
                      </div>
                      {r.suggested_diff && (
                        <details className="mt-3">
                          <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
                            Preview suggested diff
                          </summary>
                          <div className="mt-2">
                            <DiffView diff={r.suggested_diff} />
                          </div>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
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
              {detail.status !== 'dismissed' && detail.status !== 'applied' && (
                <Button variant="secondary" onClick={() => dismiss(detail.id)} disabled={busy}>
                  Dismiss
                </Button>
              )}
              {detail.status !== 'applied' && (
                <Button variant="primary" onClick={() => apply(detail.id)} disabled={busy}>
                  Apply
                </Button>
              )}
            </>
          )
        }
      >
        {detail && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{fmtKind(detail.kind)}</Badge>
              <Badge tone={statusTone(detail.status)}>{detail.status}</Badge>
              <span className="text-xs text-zinc-500">
                Risk delta:{' '}
                <span className={detail.risk_delta != null && detail.risk_delta < 0 ? 'text-emerald-400' : 'text-zinc-300'}>
                  {fmtDelta(detail.risk_delta)}
                </span>
              </span>
            </div>
            {detail.detail && <p className="text-zinc-300">{detail.detail}</p>}

            {detail.suggested_diff ? (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Suggested diff</div>
                <DiffView diff={detail.suggested_diff} />
              </div>
            ) : (
              <p className="text-xs text-zinc-500">No diff attached to this recommendation.</p>
            )}

            <div className="grid grid-cols-2 gap-4 text-xs text-zinc-500">
              <div>Created {fmtDate(detail.created_at)}</div>
              {detail.applied_at && (
                <div>
                  Applied {fmtDate(detail.applied_at)}
                  {detail.applied_by ? ` by ${detail.applied_by}` : ''}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
