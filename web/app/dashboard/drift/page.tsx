'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge, severityTone } from '@/components/ui/Badge'
import { Stat } from '@/components/ui/Stat'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'

interface Workspace {
  id: string
  name: string
}

interface Snapshot {
  id: string
  workspace_id: string
  label: string | null
  is_baseline: boolean
  pipeline_count: number | null
  finding_count: number | null
  created_at: string
}

interface DriftEvent {
  id: string
  workspace_id: string
  pipeline_id: string | null
  from_snapshot_id: string | null
  to_snapshot_id: string | null
  change_type: string
  before: unknown
  after: unknown
  severity: string | null
  status: string | null
  created_at: string
}

const WS_KEY = 'cppa.workspaceId'

function fmt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function statusTone(status: string | null): 'neutral' | 'success' | 'critical' | 'warning' {
  switch ((status ?? '').toLowerCase()) {
    case 'approved':
    case 'accepted':
      return 'success'
    case 'rejected':
      return 'critical'
    case 'pending':
    case 'open':
      return 'warning'
    default:
      return 'neutral'
  }
}

function preview(value: unknown): string {
  if (value == null) return '—'
  if (typeof value === 'string') return value
  try {
    const s = JSON.stringify(value)
    return s.length > 120 ? `${s.slice(0, 120)}…` : s
  } catch {
    return String(value)
  }
}

export default function DriftPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [drift, setDrift] = useState<DriftEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [severityFilter, setSeverityFilter] = useState<string>('all')

  const [showSnapshotForm, setShowSnapshotForm] = useState(false)
  const [detectFrom, setDetectFrom] = useState('')
  const [detectTo, setDetectTo] = useState('')
  const [eventDetail, setEventDetail] = useState<DriftEvent | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const ws: Workspace[] = await api.listWorkspaces()
        if (cancelled) return
        setWorkspaces(ws || [])
        const stored = typeof window !== 'undefined' ? window.localStorage.getItem(WS_KEY) : null
        const initial = (stored && ws?.some((w) => w.id === stored) ? stored : ws?.[0]?.id) || ''
        setWorkspaceId(initial)
        if (!initial) setLoading(false)
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load workspaces')
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const reload = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError(null)
    try {
      const [snaps, events]: [Snapshot[], DriftEvent[]] = await Promise.all([
        api.listSnapshots(workspaceId),
        api.listDrift(workspaceId),
      ])
      const sorted = (snaps || []).slice().sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
      setSnapshots(sorted)
      setDrift((events || []).slice().sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load drift data')
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    if (workspaceId) {
      if (typeof window !== 'undefined') window.localStorage.setItem(WS_KEY, workspaceId)
      reload()
    }
  }, [workspaceId, reload])

  const baseline = useMemo(() => snapshots.find((s) => s.is_baseline) || null, [snapshots])

  // Default the detect selectors to baseline → latest non-baseline.
  useEffect(() => {
    if (snapshots.length === 0) return
    setDetectFrom((prev) => prev || baseline?.id || snapshots[snapshots.length - 1]?.id || '')
    setDetectTo((prev) => prev || snapshots[0]?.id || '')
  }, [snapshots, baseline])

  const filteredDrift = useMemo(() => {
    return drift.filter((e) => {
      if (statusFilter !== 'all' && (e.status ?? '') !== statusFilter) return false
      if (severityFilter !== 'all' && (e.severity ?? '') !== severityFilter) return false
      return true
    })
  }, [drift, statusFilter, severityFilter])

  const stats = useMemo(() => {
    const pending = drift.filter((e) => ['pending', 'open', ''].includes((e.status ?? '').toLowerCase())).length
    const critical = drift.filter((e) => (e.severity ?? '').toLowerCase() === 'critical').length
    return { snapshots: snapshots.length, events: drift.length, pending, critical }
  }, [drift, snapshots])

  const flash = (msg: string) => {
    setNotice(msg)
    setTimeout(() => setNotice(null), 4000)
  }

  const createSnapshot = async (label: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.createSnapshot({ workspace_id: workspaceId, label })
      setShowSnapshotForm(false)
      await reload()
      flash('Snapshot captured')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create snapshot')
    } finally {
      setBusy(false)
    }
  }

  const baselineToggle = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.setBaseline(id)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set baseline')
    } finally {
      setBusy(false)
    }
  }

  const removeSnapshot = async (id: string) => {
    if (!confirm('Delete this snapshot?')) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteSnapshot(id)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete snapshot')
    } finally {
      setBusy(false)
    }
  }

  const runDetect = async () => {
    if (!detectFrom || !detectTo || detectFrom === detectTo) {
      setError('Pick two different snapshots to compare')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api.detectDrift({
        workspace_id: workspaceId,
        from_snapshot_id: detectFrom,
        to_snapshot_id: detectTo,
      })
      await reload()
      flash(`Detected ${res?.events ?? 0} drift event(s)`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to detect drift')
    } finally {
      setBusy(false)
    }
  }

  const setEventStatus = async (id: string, status: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.updateDrift(id, { status })
      if (eventDetail?.id === id) setEventDetail({ ...eventDetail, status })
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update drift event')
    } finally {
      setBusy(false)
    }
  }

  const snapLabel = (id: string | null) => {
    if (!id) return '—'
    const s = snapshots.find((x) => x.id === id)
    return s?.label || `${id.slice(0, 8)}…`
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-zinc-100">Posture Drift</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Capture posture snapshots, pin a baseline, and detect permission drift between any two points in time.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {workspaces.length > 1 && (
            <select
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
          <Button onClick={() => setShowSnapshotForm(true)} disabled={!workspaceId || busy}>
            + Capture snapshot
          </Button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
          {notice}
        </div>
      )}

      {!workspaceId && !loading && !error && (
        <EmptyState title="No workspace yet" description="Create or seed a workspace to start tracking drift." />
      )}

      {workspaceId && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Snapshots" value={stats.snapshots} />
            <Stat label="Drift events" value={stats.events} />
            <Stat label="Pending review" value={stats.pending} accent={stats.pending ? 'amber' : 'emerald'} />
            <Stat label="Critical drift" value={stats.critical} accent={stats.critical ? 'red' : 'emerald'} />
          </div>

          {/* Detect drift control */}
          <Card>
            <CardHeader>
              <CardTitle>Detect drift between snapshots</CardTitle>
            </CardHeader>
            <CardBody>
              {snapshots.length < 2 ? (
                <p className="text-sm text-zinc-500">
                  Capture at least two snapshots to compare. {baseline ? '' : 'Pin one as the baseline to anchor comparisons.'}
                </p>
              ) : (
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label className="mb-1 block text-xs uppercase text-zinc-500">From (baseline)</label>
                    <select
                      value={detectFrom}
                      onChange={(e) => setDetectFrom(e.target.value)}
                      className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
                    >
                      {snapshots.map((s) => (
                        <option key={s.id} value={s.id}>
                          {(s.label || s.id.slice(0, 8)) + (s.is_baseline ? ' (baseline)' : '')}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="self-center pb-2 text-zinc-600">→</div>
                  <div>
                    <label className="mb-1 block text-xs uppercase text-zinc-500">To (current)</label>
                    <select
                      value={detectTo}
                      onChange={(e) => setDetectTo(e.target.value)}
                      className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
                    >
                      {snapshots.map((s) => (
                        <option key={s.id} value={s.id}>
                          {(s.label || s.id.slice(0, 8)) + (s.is_baseline ? ' (baseline)' : '')}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button onClick={runDetect} disabled={busy}>
                    Detect drift
                  </Button>
                </div>
              )}
            </CardBody>
          </Card>

          {loading ? (
            <div className="flex justify-center py-16">
              <Spinner label="Loading drift data..." />
            </div>
          ) : (
            <>
              {/* Snapshot timeline */}
              <Card>
                <CardHeader>
                  <CardTitle>Snapshot timeline</CardTitle>
                </CardHeader>
                <CardBody>
                  {snapshots.length === 0 ? (
                    <EmptyState
                      title="No snapshots yet"
                      description="Capture your first posture snapshot to begin tracking change over time."
                      action={
                        <Button onClick={() => setShowSnapshotForm(true)} disabled={busy}>
                          + Capture snapshot
                        </Button>
                      }
                    />
                  ) : (
                    <ol className="relative space-y-4 border-l border-zinc-800 pl-6">
                      {snapshots.map((s) => (
                        <li key={s.id} className="relative">
                          <span
                            className={`absolute -left-[1.6rem] top-1 h-3 w-3 rounded-full border-2 ${
                              s.is_baseline
                                ? 'border-red-500 bg-red-500'
                                : 'border-zinc-600 bg-zinc-900'
                            }`}
                          />
                          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-zinc-100">{s.label || s.id.slice(0, 8)}</span>
                                {s.is_baseline && <Badge tone="critical">baseline</Badge>}
                              </div>
                              <div className="mt-1 text-xs text-zinc-500">
                                {fmt(s.created_at)} · {s.pipeline_count ?? 0} pipelines · {s.finding_count ?? 0} findings
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <Button size="sm" variant="secondary" onClick={() => baselineToggle(s.id)} disabled={busy}>
                                {s.is_baseline ? 'Unpin baseline' : 'Pin as baseline'}
                              </Button>
                              <Button size="sm" variant="danger" onClick={() => removeSnapshot(s.id)} disabled={busy}>
                                Delete
                              </Button>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </CardBody>
              </Card>

              {/* Drift events */}
              <Card>
                <CardHeader className="flex flex-wrap items-center justify-between gap-3">
                  <CardTitle>Drift events</CardTitle>
                  <div className="flex gap-2">
                    <select
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                      className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200"
                    >
                      <option value="all">All status</option>
                      <option value="pending">Pending</option>
                      <option value="approved">Approved</option>
                      <option value="rejected">Rejected</option>
                    </select>
                    <select
                      value={severityFilter}
                      onChange={(e) => setSeverityFilter(e.target.value)}
                      className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200"
                    >
                      <option value="all">All severity</option>
                      <option value="critical">Critical</option>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </select>
                  </div>
                </CardHeader>
                <CardBody>
                  {filteredDrift.length === 0 ? (
                    <EmptyState
                      title={drift.length === 0 ? 'No drift detected' : 'No events match your filters'}
                      description={
                        drift.length === 0
                          ? 'Run a detect between two snapshots to surface posture changes.'
                          : 'Adjust the status or severity filters.'
                      }
                    />
                  ) : (
                    <Table>
                      <THead>
                        <TR>
                          <TH>Change</TH>
                          <TH>Comparison</TH>
                          <TH>Severity</TH>
                          <TH>Status</TH>
                          <TH>When</TH>
                          <TH className="text-right">Actions</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {filteredDrift.map((e) => (
                          <TR key={e.id}>
                            <TD>
                              <button
                                className="font-medium text-zinc-100 hover:text-red-400"
                                onClick={() => setEventDetail(e)}
                              >
                                {e.change_type}
                              </button>
                              {e.pipeline_id && (
                                <div className="mt-0.5 font-mono text-[11px] text-zinc-500">
                                  {e.pipeline_id.slice(0, 12)}…
                                </div>
                              )}
                            </TD>
                            <TD>
                              <span className="text-xs text-zinc-400">
                                {snapLabel(e.from_snapshot_id)} → {snapLabel(e.to_snapshot_id)}
                              </span>
                            </TD>
                            <TD>
                              {e.severity ? (
                                <Badge tone={severityTone(e.severity)}>{e.severity}</Badge>
                              ) : (
                                <span className="text-zinc-600">—</span>
                              )}
                            </TD>
                            <TD>
                              <Badge tone={statusTone(e.status)}>{e.status || 'pending'}</Badge>
                            </TD>
                            <TD>
                              <span className="text-xs text-zinc-500">{fmt(e.created_at)}</span>
                            </TD>
                            <TD className="text-right">
                              <div className="flex justify-end gap-2">
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => setEventStatus(e.id, 'approved')}
                                  disabled={busy}
                                >
                                  Approve
                                </Button>
                                <Button
                                  size="sm"
                                  variant="danger"
                                  onClick={() => setEventStatus(e.id, 'rejected')}
                                  disabled={busy}
                                >
                                  Reject
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
        </>
      )}

      {showSnapshotForm && (
        <SnapshotForm onClose={() => setShowSnapshotForm(false)} onCreate={createSnapshot} busy={busy} />
      )}

      <Modal open={!!eventDetail} onClose={() => setEventDetail(null)} title="Drift event detail" size="lg">
        {eventDetail && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-lg font-semibold text-zinc-100">{eventDetail.change_type}</span>
              <div className="flex gap-2">
                {eventDetail.severity && <Badge tone={severityTone(eventDetail.severity)}>{eventDetail.severity}</Badge>}
                <Badge tone={statusTone(eventDetail.status)}>{eventDetail.status || 'pending'}</Badge>
              </div>
            </div>
            <div className="text-xs text-zinc-500">
              {snapLabel(eventDetail.from_snapshot_id)} → {snapLabel(eventDetail.to_snapshot_id)} · {fmt(eventDetail.created_at)}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <div className="mb-1 text-xs uppercase text-zinc-500">Before</div>
                <pre className="max-h-60 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300">
                  {preview(eventDetail.before)}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-xs uppercase text-zinc-500">After</div>
                <pre className="max-h-60 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300">
                  {preview(eventDetail.after)}
                </pre>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setEventStatus(eventDetail.id, 'approved')} disabled={busy}>
                Approve
              </Button>
              <Button variant="danger" onClick={() => setEventStatus(eventDetail.id, 'rejected')} disabled={busy}>
                Reject
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

function SnapshotForm({
  onClose,
  onCreate,
  busy,
}: {
  onClose: () => void
  onCreate: (label: string) => void
  busy: boolean
}) {
  const [label, setLabel] = useState('')
  return (
    <Modal
      open
      onClose={onClose}
      title="Capture posture snapshot"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onCreate(label.trim() || `Snapshot ${new Date().toLocaleDateString()}`)} disabled={busy}>
            {busy ? 'Capturing...' : 'Capture'}
          </Button>
        </>
      }
    >
      <div>
        <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">Label</label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Pre-release audit"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
        />
        <p className="mt-2 text-xs text-zinc-500">
          A snapshot freezes the current posture (pipelines, permissions, findings) so it can be diffed later.
        </p>
      </div>
    </Modal>
  )
}
