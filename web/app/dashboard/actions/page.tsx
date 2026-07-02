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
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'

interface Workspace {
  id: string
  name: string
}

interface Action {
  id: string
  workspace_id: string
  name: string
  publisher: string | null
  pin_type: string
  pin_ref: string | null
  is_verified_publisher: boolean
  inherited_privileges: string[] | null
  risk_level: string
  usage_count: number
  is_deprecated: boolean
  created_at: string
}

interface AffectedPipeline {
  id: string
  name: string
  repo?: string
}

interface ActionDetail extends Action {
  pipelines?: AffectedPipeline[]
}

const PIN_TYPES = ['sha', 'tag', 'branch', 'major', 'unpinned']
const RISK_LEVELS = ['critical', 'high', 'medium', 'low']

function riskTone(level: string): 'critical' | 'high' | 'medium' | 'low' | 'neutral' {
  switch (level?.toLowerCase()) {
    case 'critical':
      return 'critical'
    case 'high':
      return 'high'
    case 'medium':
      return 'medium'
    case 'low':
      return 'low'
    default:
      return 'neutral'
  }
}

// A pin that is not a SHA is mutable and swappable under you.
function isMutablePin(a: Action) {
  return a.pin_type !== 'sha'
}

const EMPTY_FORM = {
  name: '',
  publisher: '',
  pin_type: 'tag',
  pin_ref: '',
  is_verified_publisher: false,
  risk_level: 'medium',
  usage_count: 0,
  is_deprecated: false,
  inherited_privileges: '',
}

export default function ActionsPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [actions, setActions] = useState<Action[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [riskFilter, setRiskFilter] = useState('all')
  const [pinFilter, setPinFilter] = useState('all')

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Action | null>(null)
  const [form, setForm] = useState({ ...EMPTY_FORM })

  const [detail, setDetail] = useState<ActionDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  async function loadActions(wsId: string) {
    const rows: Action[] = await api.listActions(wsId)
    setActions(rows)
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
        await loadActions(wsId)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load actions')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const stats = useMemo(() => {
    let mutable = 0
    let unverified = 0
    let deprecated = 0
    for (const a of actions) {
      if (isMutablePin(a)) mutable += 1
      if (!a.is_verified_publisher) unverified += 1
      if (a.is_deprecated) deprecated += 1
    }
    return { total: actions.length, mutable, unverified, deprecated }
  }, [actions])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return actions
      .filter((a) => riskFilter === 'all' || a.risk_level?.toLowerCase() === riskFilter)
      .filter((a) =>
        pinFilter === 'all'
          ? true
          : pinFilter === 'mutable'
            ? isMutablePin(a)
            : a.pin_type === pinFilter,
      )
      .filter(
        (a) =>
          !q ||
          a.name.toLowerCase().includes(q) ||
          (a.publisher ?? '').toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const ra = RISK_LEVELS.indexOf(a.risk_level?.toLowerCase())
        const rb = RISK_LEVELS.indexOf(b.risk_level?.toLowerCase())
        if (ra !== rb) return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb)
        return b.usage_count - a.usage_count
      })
  }, [actions, search, riskFilter, pinFilter])

  // Risk-map buckets for the simple SVG-free visual grid.
  const riskBuckets = useMemo(() => {
    const buckets: Record<string, Action[]> = { critical: [], high: [], medium: [], low: [] }
    for (const a of filtered) {
      const r = a.risk_level?.toLowerCase()
      if (r in buckets) buckets[r].push(a)
    }
    return buckets
  }, [filtered])

  function flash(msg: string) {
    setBanner(msg)
    setTimeout(() => setBanner(null), 4000)
  }

  function openCreate() {
    setEditing(null)
    setForm({ ...EMPTY_FORM })
    setFormOpen(true)
  }

  function openEdit(a: Action) {
    setEditing(a)
    setForm({
      name: a.name,
      publisher: a.publisher ?? '',
      pin_type: a.pin_type,
      pin_ref: a.pin_ref ?? '',
      is_verified_publisher: a.is_verified_publisher,
      risk_level: a.risk_level,
      usage_count: a.usage_count,
      is_deprecated: a.is_deprecated,
      inherited_privileges: (a.inherited_privileges ?? []).join(', '),
    })
    setFormOpen(true)
  }

  function buildBody() {
    return {
      workspace_id: workspaceId,
      name: form.name.trim(),
      publisher: form.publisher.trim() || null,
      pin_type: form.pin_type,
      pin_ref: form.pin_ref.trim() || null,
      is_verified_publisher: form.is_verified_publisher,
      risk_level: form.risk_level,
      usage_count: Number(form.usage_count) || 0,
      is_deprecated: form.is_deprecated,
      inherited_privileges: form.inherited_privileges
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    }
  }

  async function submitForm() {
    if (!workspaceId || !form.name.trim()) return
    setBusy(true)
    setError(null)
    try {
      if (editing) {
        const updated: Action = await api.updateAction(editing.id, buildBody())
        setActions((prev) => prev.map((a) => (a.id === editing.id ? { ...a, ...updated } : a)))
        flash('Action updated.')
      } else {
        const created: Action = await api.createAction(buildBody())
        setActions((prev) => [created, ...prev])
        flash('Action added to inventory.')
      }
      setFormOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  // Pin tag -> sha recommendation: flip pin_type to sha.
  async function pinToSha(a: Action) {
    setBusy(true)
    setError(null)
    try {
      const updated: Action = await api.updateAction(a.id, { pin_type: 'sha' })
      setActions((prev) => prev.map((x) => (x.id === a.id ? { ...x, ...updated } : x)))
      flash(`${a.name} marked pinned to SHA.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setBusy(false)
    }
  }

  async function removeAction(a: Action) {
    if (!confirm(`Delete action "${a.name}"? This cannot be undone.`)) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteAction(a.id)
      setActions((prev) => prev.filter((x) => x.id !== a.id))
      if (detail?.id === a.id) setDetail(null)
      flash('Action deleted.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  async function openDetail(a: Action) {
    setDetail(a)
    setDetailLoading(true)
    try {
      const full: ActionDetail = await api.getAction(a.id)
      setDetail(full)
    } catch {
      // keep the row-level data we already have
    } finally {
      setDetailLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner label="Loading third-party actions..." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100">Third-Party Action Risk Map</h1>
          <p className="mt-1 text-sm text-slate-500">
            Every Action, include, and plugin — pin type, publisher trust, inherited privilege, and usage.
          </p>
        </div>
        <Button variant="primary" onClick={openCreate} disabled={!workspaceId}>
          Add action
        </Button>
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
          description="Seed sample data from the dashboard to populate the action inventory."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Actions" value={stats.total} />
            <Stat label="Mutable pin" value={stats.mutable} accent="red" hint="tag / branch / unpinned" />
            <Stat label="Unverified publisher" value={stats.unverified} accent="amber" />
            <Stat label="Deprecated" value={stats.deprecated} accent="amber" />
          </div>

          {/* Risk map: column per risk level */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
            {RISK_LEVELS.map((level) => (
              <Card key={level}>
                <CardHeader className="flex items-center justify-between">
                  <CardTitle className="capitalize">{level}</CardTitle>
                  <Badge tone={riskTone(level)}>{riskBuckets[level].length}</Badge>
                </CardHeader>
                <CardBody className="space-y-2">
                  {riskBuckets[level].length === 0 ? (
                    <div className="py-4 text-center text-xs text-slate-600">None</div>
                  ) : (
                    riskBuckets[level].map((a) => (
                      <button
                        key={a.id}
                        onClick={() => openDetail(a)}
                        className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-left hover:border-red-800/60"
                      >
                        <span className="min-w-0 truncate text-xs font-medium text-slate-200">{a.name}</span>
                        {isMutablePin(a) && (
                          <span
                            className="h-2 w-2 shrink-0 rounded-full bg-red-500"
                            title="Mutable pin"
                          />
                        )}
                      </button>
                    ))
                  )}
                </CardBody>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle>Inventory</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name or publisher..."
                  className="w-56 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-red-600 focus:outline-none"
                />
                <select
                  value={riskFilter}
                  onChange={(e) => setRiskFilter(e.target.value)}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 focus:border-red-600 focus:outline-none"
                >
                  <option value="all">All risk</option>
                  {RISK_LEVELS.map((r) => (
                    <option key={r} value={r}>
                      {r[0].toUpperCase() + r.slice(1)}
                    </option>
                  ))}
                </select>
                <select
                  value={pinFilter}
                  onChange={(e) => setPinFilter(e.target.value)}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 focus:border-red-600 focus:outline-none"
                >
                  <option value="all">All pins</option>
                  <option value="mutable">Mutable only</option>
                  {PIN_TYPES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              {filtered.length === 0 ? (
                <div className="px-5 py-10">
                  <EmptyState
                    title="No actions match"
                    description="Adjust filters or add an action to the inventory."
                    action={
                      <Button variant="primary" onClick={openCreate}>
                        Add action
                      </Button>
                    }
                  />
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Action</TH>
                      <TH>Publisher</TH>
                      <TH>Pin</TH>
                      <TH>Risk</TH>
                      <TH>Usage</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {filtered.map((a) => (
                      <TR key={a.id}>
                        <TD>
                          <button
                            onClick={() => openDetail(a)}
                            className="text-left font-medium text-slate-100 hover:text-red-300"
                          >
                            {a.name}
                          </button>
                          <div className="mt-0.5 flex gap-1.5">
                            {a.is_deprecated && <Badge tone="warning">deprecated</Badge>}
                            {(a.inherited_privileges?.length ?? 0) > 0 && (
                              <Badge tone="neutral">{a.inherited_privileges!.length} inherited</Badge>
                            )}
                          </div>
                        </TD>
                        <TD>
                          <div className="flex items-center gap-1.5">
                            <span className="text-slate-300">{a.publisher || '—'}</span>
                            {a.is_verified_publisher ? (
                              <Badge tone="success">verified</Badge>
                            ) : (
                              <Badge tone="warning">unverified</Badge>
                            )}
                          </div>
                        </TD>
                        <TD>
                          <div className="flex items-center gap-1.5">
                            <Badge tone={isMutablePin(a) ? 'critical' : 'success'}>{a.pin_type}</Badge>
                            {a.pin_ref && (
                              <code className="text-xs text-slate-500">{a.pin_ref.slice(0, 14)}</code>
                            )}
                          </div>
                        </TD>
                        <TD>
                          <Badge tone={riskTone(a.risk_level)}>{a.risk_level}</Badge>
                        </TD>
                        <TD className="text-slate-400">{a.usage_count}</TD>
                        <TD>
                          <div className="flex justify-end gap-1.5">
                            {isMutablePin(a) && (
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => pinToSha(a)}
                                disabled={busy}
                                title="Pin tag → SHA"
                              >
                                Pin → SHA
                              </Button>
                            )}
                            <Button size="sm" variant="secondary" onClick={() => openEdit(a)} disabled={busy}>
                              Edit
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => removeAction(a)} disabled={busy}>
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

      {/* Create / edit form */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Edit action' : 'Add action'}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submitForm} disabled={busy || !form.name.trim()}>
              {busy ? <Spinner /> : editing ? 'Save changes' : 'Add action'}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="col-span-2 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Name</span>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="actions/checkout"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-red-600 focus:outline-none"
            />
          </label>
          <label className="text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Publisher</span>
            <input
              value={form.publisher}
              onChange={(e) => setForm((f) => ({ ...f, publisher: e.target.value }))}
              placeholder="github"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-red-600 focus:outline-none"
            />
          </label>
          <label className="text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Risk level</span>
            <select
              value={form.risk_level}
              onChange={(e) => setForm((f) => ({ ...f, risk_level: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 focus:border-red-600 focus:outline-none"
            >
              {RISK_LEVELS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Pin type</span>
            <select
              value={form.pin_type}
              onChange={(e) => setForm((f) => ({ ...f, pin_type: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 focus:border-red-600 focus:outline-none"
            >
              {PIN_TYPES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Pin ref</span>
            <input
              value={form.pin_ref}
              onChange={(e) => setForm((f) => ({ ...f, pin_ref: e.target.value }))}
              placeholder="v4 or commit sha"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-red-600 focus:outline-none"
            />
          </label>
          <label className="text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Usage count</span>
            <input
              type="number"
              min={0}
              value={form.usage_count}
              onChange={(e) => setForm((f) => ({ ...f, usage_count: Number(e.target.value) }))}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 focus:border-red-600 focus:outline-none"
            />
          </label>
          <label className="col-span-2 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Inherited privileges (comma-separated)</span>
            <input
              value={form.inherited_privileges}
              onChange={(e) => setForm((f) => ({ ...f, inherited_privileges: e.target.value }))}
              placeholder="contents:write, id-token:write"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-red-600 focus:outline-none"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={form.is_verified_publisher}
              onChange={(e) => setForm((f) => ({ ...f, is_verified_publisher: e.target.checked }))}
              className="h-4 w-4 rounded border-slate-700 bg-slate-900 accent-red-600"
            />
            Verified publisher
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={form.is_deprecated}
              onChange={(e) => setForm((f) => ({ ...f, is_deprecated: e.target.checked }))}
              className="h-4 w-4 rounded border-slate-700 bg-slate-900 accent-red-600"
            />
            Deprecated
          </label>
        </div>
      </Modal>

      {/* Detail */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.name}
        size="lg"
        footer={
          detail && (
            <>
              <Button variant="ghost" onClick={() => setDetail(null)}>
                Close
              </Button>
              {isMutablePin(detail) && (
                <Button variant="danger" onClick={() => pinToSha(detail)} disabled={busy}>
                  Pin → SHA
                </Button>
              )}
              <Button variant="secondary" onClick={() => { const a = detail; setDetail(null); openEdit(a) }}>
                Edit
              </Button>
            </>
          )
        }
      >
        {detail && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={riskTone(detail.risk_level)}>{detail.risk_level} risk</Badge>
              <Badge tone={isMutablePin(detail) ? 'critical' : 'success'}>{detail.pin_type}</Badge>
              {detail.is_verified_publisher ? (
                <Badge tone="success">verified publisher</Badge>
              ) : (
                <Badge tone="warning">unverified publisher</Badge>
              )}
              {detail.is_deprecated && <Badge tone="warning">deprecated</Badge>}
            </div>

            <div className="grid grid-cols-2 gap-3 text-slate-300">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Publisher</div>
                <div>{detail.publisher || '—'}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Pin ref</div>
                <code className="text-xs text-slate-400">{detail.pin_ref || '—'}</code>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Usage count</div>
                <div>{detail.usage_count}</div>
              </div>
            </div>

            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">Inherited privileges</div>
              {detail.inherited_privileges?.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {detail.inherited_privileges.map((p) => (
                    <Badge key={p} tone="neutral">
                      {p}
                    </Badge>
                  ))}
                </div>
              ) : (
                <div className="text-slate-500">None recorded</div>
              )}
            </div>

            {isMutablePin(detail) && (
              <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-3 text-xs text-red-200/80">
                This action uses a mutable <span className="font-semibold">{detail.pin_type}</span> ref. An attacker who
                controls the upstream can swap the code under you. Recommendation: pin tag → SHA across all affected
                pipelines.
              </div>
            )}

            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">Affected pipelines</div>
              {detailLoading ? (
                <Spinner label="Loading affected pipelines..." />
              ) : detail.pipelines?.length ? (
                <ul className="space-y-1">
                  {detail.pipelines.map((p) => (
                    <li
                      key={p.id}
                      className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-1.5 text-slate-300"
                    >
                      {p.name}
                      {p.repo && <span className="ml-2 text-xs text-slate-500">{p.repo}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-slate-500">No pipelines reference this action.</div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
