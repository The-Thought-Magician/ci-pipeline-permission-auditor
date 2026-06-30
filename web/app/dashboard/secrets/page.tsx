'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Badge } from '@/components/ui/Badge'
import { Stat } from '@/components/ui/Stat'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'

interface Workspace {
  id: string
  name: string
  rotation_age_days?: number | null
}

interface Secret {
  id: string
  workspace_id: string
  name: string
  store: string | null
  is_scoped: boolean
  is_masked: boolean
  is_plaintext: boolean
  exposed_to_fork_pr: boolean
  last_rotated_at: string | null
  rotation_age_days: number | null
  created_at: string
}

interface SecretReference {
  id: string
  pipeline_id: string
  usage_context: string | null
  is_logged: boolean
}

interface SecretDetail extends Secret {
  references?: SecretReference[]
}

const WS_KEY = 'cppa.workspaceId'

const STORES = ['github_actions', 'gitlab_ci', 'jenkins', 'vault', 'aws_secrets_manager', 'azure_keyvault', 'env_file', 'other']

function daysAgo(iso: string | null): number | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return null
  return Math.max(0, Math.floor(ms / 86_400_000))
}

function rotationAge(secret: Secret): number | null {
  if (typeof secret.rotation_age_days === 'number') return secret.rotation_age_days
  return daysAgo(secret.last_rotated_at)
}

function hygieneScore(secrets: Secret[]): number {
  if (secrets.length === 0) return 100
  let penalties = 0
  for (const s of secrets) {
    if (s.is_plaintext) penalties += 3
    if (!s.is_masked) penalties += 1
    if (!s.is_scoped) penalties += 1
    if (s.exposed_to_fork_pr) penalties += 3
  }
  const max = secrets.length * 8
  return Math.round(100 - (penalties / max) * 100)
}

type RiskFilter = 'all' | 'plaintext' | 'unmasked' | 'unscoped' | 'fork_pr' | 'stale'

export default function SecretsPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState<string>('')
  const [secrets, setSecrets] = useState<Secret[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [search, setSearch] = useState('')
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all')
  const [storeFilter, setStoreFilter] = useState<string>('all')

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<SecretDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Secret | null>(null)

  const rotationThreshold = useMemo(() => {
    const ws = workspaces.find((w) => w.id === workspaceId)
    return ws?.rotation_age_days ?? 90
  }, [workspaces, workspaceId])

  // Load workspaces once.
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
      const data: Secret[] = await api.listSecrets(workspaceId)
      setSecrets(data || [])
      setSelected(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load secrets')
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return secrets.filter((s) => {
      if (q && !s.name.toLowerCase().includes(q) && !(s.store ?? '').toLowerCase().includes(q)) return false
      if (storeFilter !== 'all' && (s.store ?? '') !== storeFilter) return false
      const age = rotationAge(s)
      switch (riskFilter) {
        case 'plaintext':
          return s.is_plaintext
        case 'unmasked':
          return !s.is_masked
        case 'unscoped':
          return !s.is_scoped
        case 'fork_pr':
          return s.exposed_to_fork_pr
        case 'stale':
          return age != null && age > rotationThreshold
        default:
          return true
      }
    })
  }, [secrets, search, riskFilter, storeFilter, rotationThreshold])

  const stores = useMemo(() => {
    const set = new Set<string>()
    secrets.forEach((s) => s.store && set.add(s.store))
    return Array.from(set).sort()
  }, [secrets])

  const stats = useMemo(() => {
    const plaintext = secrets.filter((s) => s.is_plaintext).length
    const forkPr = secrets.filter((s) => s.exposed_to_fork_pr).length
    const stale = secrets.filter((s) => {
      const a = rotationAge(s)
      return a != null && a > rotationThreshold
    }).length
    return { total: secrets.length, plaintext, forkPr, stale, hygiene: hygieneScore(secrets) }
  }, [secrets, rotationThreshold])

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAll = () => {
    setSelected((prev) => (prev.size === filtered.length ? new Set() : new Set(filtered.map((s) => s.id))))
  }

  const openDetail = async (id: string) => {
    setDetail(null)
    setDetailLoading(true)
    try {
      const d: SecretDetail = await api.getSecret(id)
      setDetail(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load secret detail')
    } finally {
      setDetailLoading(false)
    }
  }

  const rotate = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.rotateSecret(id)
      await reload()
      if (detail?.id === id) await openDetail(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rotate secret')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this secret record? This cannot be undone.')) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteSecret(id)
      if (detail?.id === id) setDetail(null)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete secret')
    } finally {
      setBusy(false)
    }
  }

  const bulkRotate = async () => {
    if (selected.size === 0) return
    setBusy(true)
    setError(null)
    try {
      for (const id of selected) await api.rotateSecret(id)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bulk rotation failed')
    } finally {
      setBusy(false)
    }
  }

  const bulkDelete = async () => {
    if (selected.size === 0) return
    if (!confirm(`Delete ${selected.size} secret record(s)?`)) return
    setBusy(true)
    setError(null)
    try {
      for (const id of selected) await api.deleteSecret(id)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bulk delete failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-zinc-100">Secrets in CI</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Track every secret referenced by your pipelines, surface plaintext and fork-PR exposure, and drive
            rotation hygiene.
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
          <Button
            onClick={() => {
              setEditing(null)
              setShowForm(true)
            }}
            disabled={!workspaceId}
          >
            + Add secret
          </Button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {!workspaceId && !loading && !error && (
        <EmptyState
          title="No workspace yet"
          description="Create or seed a workspace from the dashboard to start tracking secrets."
        />
      )}

      {workspaceId && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Tracked secrets" value={stats.total} />
            <Stat label="Plaintext" value={stats.plaintext} accent={stats.plaintext ? 'red' : 'emerald'} />
            <Stat label="Fork-PR exposed" value={stats.forkPr} accent={stats.forkPr ? 'red' : 'emerald'} />
            <Stat
              label={`Stale (>${rotationThreshold}d)`}
              value={stats.stale}
              accent={stats.stale ? 'amber' : 'emerald'}
            />
            <Stat
              label="Hygiene score"
              value={`${stats.hygiene}`}
              accent={stats.hygiene >= 80 ? 'emerald' : stats.hygiene >= 50 ? 'amber' : 'red'}
              hint="0–100, higher is safer"
            />
          </div>

          <Card>
            <CardBody className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name or store..."
                  className="min-w-[200px] flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600"
                />
                <select
                  value={riskFilter}
                  onChange={(e) => setRiskFilter(e.target.value as RiskFilter)}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
                >
                  <option value="all">All risk</option>
                  <option value="plaintext">Plaintext</option>
                  <option value="unmasked">Unmasked</option>
                  <option value="unscoped">Unscoped</option>
                  <option value="fork_pr">Fork-PR exposed</option>
                  <option value="stale">Stale rotation</option>
                </select>
                <select
                  value={storeFilter}
                  onChange={(e) => setStoreFilter(e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
                >
                  <option value="all">All stores</option>
                  {stores.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              {selected.size > 0 && (
                <div className="flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900/80 px-4 py-2 text-sm">
                  <span className="text-zinc-400">{selected.size} selected</span>
                  <Button size="sm" variant="secondary" onClick={bulkRotate} disabled={busy}>
                    Rotate selected
                  </Button>
                  <Button size="sm" variant="danger" onClick={bulkDelete} disabled={busy}>
                    Delete selected
                  </Button>
                  <button className="ml-auto text-zinc-500 hover:text-zinc-300" onClick={() => setSelected(new Set())}>
                    Clear
                  </button>
                </div>
              )}

              {loading ? (
                <div className="flex justify-center py-16">
                  <Spinner label="Loading secrets..." />
                </div>
              ) : filtered.length === 0 ? (
                <EmptyState
                  title={secrets.length === 0 ? 'No secrets tracked' : 'No secrets match your filters'}
                  description={
                    secrets.length === 0
                      ? 'Add a secret manually or sync a provider connection to discover secrets used in CI.'
                      : 'Try clearing the search or risk filters.'
                  }
                  action={
                    secrets.length === 0 ? (
                      <Button
                        onClick={() => {
                          setEditing(null)
                          setShowForm(true)
                        }}
                      >
                        + Add secret
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH className="w-10">
                        <input
                          type="checkbox"
                          checked={selected.size === filtered.length && filtered.length > 0}
                          onChange={toggleAll}
                          aria-label="Select all"
                        />
                      </TH>
                      <TH>Name</TH>
                      <TH>Store</TH>
                      <TH>Flags</TH>
                      <TH>Rotation</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {filtered.map((s) => {
                      const age = rotationAge(s)
                      const stale = age != null && age > rotationThreshold
                      return (
                        <TR key={s.id}>
                          <TD>
                            <input
                              type="checkbox"
                              checked={selected.has(s.id)}
                              onChange={() => toggleSelect(s.id)}
                              aria-label={`Select ${s.name}`}
                            />
                          </TD>
                          <TD>
                            <button
                              className="font-medium text-zinc-100 hover:text-red-400"
                              onClick={() => openDetail(s.id)}
                            >
                              {s.name}
                            </button>
                          </TD>
                          <TD>
                            <span className="text-zinc-400">{s.store || '—'}</span>
                          </TD>
                          <TD>
                            <div className="flex flex-wrap gap-1">
                              {s.is_plaintext && <Badge tone="critical">plaintext</Badge>}
                              {!s.is_masked && <Badge tone="high">unmasked</Badge>}
                              {!s.is_scoped && <Badge tone="medium">unscoped</Badge>}
                              {s.exposed_to_fork_pr && <Badge tone="critical">fork-PR</Badge>}
                              {s.is_masked && s.is_scoped && !s.is_plaintext && !s.exposed_to_fork_pr && (
                                <Badge tone="success">hardened</Badge>
                              )}
                            </div>
                          </TD>
                          <TD>
                            <div className="flex items-center gap-2">
                              <span className={stale ? 'text-amber-400' : 'text-zinc-400'}>
                                {age == null ? 'never' : `${age}d ago`}
                              </span>
                              {stale && <Badge tone="warning">stale</Badge>}
                            </div>
                          </TD>
                          <TD className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button size="sm" variant="secondary" onClick={() => rotate(s.id)} disabled={busy}>
                                Rotate
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setEditing(s)
                                  setShowForm(true)
                                }}
                              >
                                Edit
                              </Button>
                              <Button size="sm" variant="danger" onClick={() => remove(s.id)} disabled={busy}>
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

      {showForm && (
        <SecretForm
          workspaceId={workspaceId}
          editing={editing}
          onClose={() => setShowForm(false)}
          onSaved={async () => {
            setShowForm(false)
            await reload()
          }}
        />
      )}

      <Modal open={!!detail || detailLoading} onClose={() => setDetail(null)} title="Secret detail" size="lg">
        {detailLoading ? (
          <div className="flex justify-center py-8">
            <Spinner label="Loading..." />
          </div>
        ) : detail ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-lg font-semibold text-zinc-100">{detail.name}</div>
              <span className="text-sm text-zinc-500">{detail.store || 'unknown store'}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone={detail.is_masked ? 'success' : 'high'}>
                {detail.is_masked ? 'masked' : 'unmasked'}
              </Badge>
              <Badge tone={detail.is_scoped ? 'success' : 'medium'}>
                {detail.is_scoped ? 'scoped' : 'unscoped'}
              </Badge>
              {detail.is_plaintext && <Badge tone="critical">plaintext</Badge>}
              {detail.exposed_to_fork_pr && <Badge tone="critical">fork-PR exposed</Badge>}
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-xs uppercase text-zinc-500">Last rotated</div>
                <div className="text-zinc-200">
                  {detail.last_rotated_at ? new Date(detail.last_rotated_at).toLocaleString() : 'never'}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase text-zinc-500">Rotation age</div>
                <div className="text-zinc-200">
                  {rotationAge(detail) == null ? '—' : `${rotationAge(detail)} days`}
                </div>
              </div>
            </div>
            <div>
              <div className="mb-2 text-xs uppercase text-zinc-500">
                Referenced by ({detail.references?.length ?? 0} pipeline{(detail.references?.length ?? 0) === 1 ? '' : 's'})
              </div>
              {detail.references && detail.references.length > 0 ? (
                <div className="space-y-1">
                  {detail.references.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm"
                    >
                      <span className="font-mono text-xs text-zinc-300">{r.pipeline_id}</span>
                      <div className="flex items-center gap-2">
                        {r.usage_context && <span className="text-zinc-500">{r.usage_context}</span>}
                        {r.is_logged && <Badge tone="critical">logged</Badge>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No pipeline references recorded.</p>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => rotate(detail.id)} disabled={busy}>
                Rotate now
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(detail)
                  setDetail(null)
                  setShowForm(true)
                }}
              >
                Edit
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

function SecretForm({
  workspaceId,
  editing,
  onClose,
  onSaved,
}: {
  workspaceId: string
  editing: Secret | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(editing?.name ?? '')
  const [store, setStore] = useState(editing?.store ?? 'github_actions')
  const [isScoped, setIsScoped] = useState(editing?.is_scoped ?? false)
  const [isMasked, setIsMasked] = useState(editing?.is_masked ?? true)
  const [isPlaintext, setIsPlaintext] = useState(editing?.is_plaintext ?? false)
  const [exposedToForkPr, setExposedToForkPr] = useState(editing?.exposed_to_fork_pr ?? false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (!name.trim()) {
      setErr('Name is required')
      return
    }
    setSaving(true)
    setErr(null)
    const body = {
      workspace_id: workspaceId,
      name: name.trim(),
      store,
      is_scoped: isScoped,
      is_masked: isMasked,
      is_plaintext: isPlaintext,
      exposed_to_fork_pr: exposedToForkPr,
    }
    try {
      if (editing) await api.updateSecret(editing.id, body)
      else await api.createSecret(body)
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save secret')
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Edit secret' : 'Add secret'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Saving...' : editing ? 'Save changes' : 'Add secret'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {err && <div className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-300">{err}</div>}
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="AWS_DEPLOY_KEY"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">Store</label>
          <select
            value={store ?? ''}
            onChange={(e) => setStore(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
          >
            {STORES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Toggle label="Masked in logs" checked={isMasked} onChange={setIsMasked} />
          <Toggle label="Scoped to job/env" checked={isScoped} onChange={setIsScoped} />
          <Toggle label="Stored in plaintext" checked={isPlaintext} onChange={setIsPlaintext} danger />
          <Toggle label="Exposed to fork PRs" checked={exposedToForkPr} onChange={setExposedToForkPr} danger />
        </div>
      </div>
    </Modal>
  )
}

function Toggle({
  label,
  checked,
  onChange,
  danger,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  danger?: boolean
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
        checked && danger
          ? 'border-red-800 bg-red-950/40 text-red-300'
          : 'border-zinc-700 bg-zinc-900 text-zinc-300'
      }`}
    >
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}
