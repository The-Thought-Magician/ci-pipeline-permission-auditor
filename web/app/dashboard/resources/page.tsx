'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/Badge'
import { Stat } from '@/components/ui/Stat'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'

interface Workspace {
  id: string
  name: string
}

interface Resource {
  id: string
  workspace_id: string
  name: string
  kind: string | null
  identifier: string | null
  is_crown_jewel: boolean
  environment: string | null
  tags: string[] | null
  created_at: string
}

interface ReachabilityEntry {
  resource_id: string
  resource_name?: string
  pipeline_count?: number
  identity_count?: number
  reachable_via?: string[]
  [key: string]: unknown
}

interface CrownJewelsResponse {
  resources: Resource[]
  reachability: ReachabilityEntry[]
}

const WS_KEY = 'cppa.workspaceId'

const KINDS = [
  's3_bucket',
  'iam_role',
  'database',
  'kms_key',
  'ecr_repository',
  'lambda',
  'secret_store',
  'compute',
  'queue',
  'registry',
  'other',
]

const ENVIRONMENTS = ['production', 'staging', 'development', 'shared', 'unknown']

type KindFilter = 'all' | string
type EnvFilter = 'all' | string
type CrownFilter = 'all' | 'crown' | 'standard'

export default function ResourcesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState<string>('')
  const [resources, setResources] = useState<Resource[]>([])
  const [crown, setCrown] = useState<CrownJewelsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [envFilter, setEnvFilter] = useState<EnvFilter>('all')
  const [crownFilter, setCrownFilter] = useState<CrownFilter>('all')

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Resource | null>(null)

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
      const [res, cj] = await Promise.all([
        api.listResources(workspaceId) as Promise<Resource[]>,
        api.getCrownJewels(workspaceId) as Promise<CrownJewelsResponse>,
      ])
      setResources(res || [])
      setCrown(cj || { resources: [], reachability: [] })
      setSelected(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load resources')
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

  const kinds = useMemo(() => {
    const set = new Set<string>()
    resources.forEach((r) => r.kind && set.add(r.kind))
    return Array.from(set).sort()
  }, [resources])

  const environments = useMemo(() => {
    const set = new Set<string>()
    resources.forEach((r) => r.environment && set.add(r.environment))
    return Array.from(set).sort()
  }, [resources])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return resources.filter((r) => {
      if (
        q &&
        !r.name.toLowerCase().includes(q) &&
        !(r.identifier ?? '').toLowerCase().includes(q) &&
        !(r.kind ?? '').toLowerCase().includes(q)
      )
        return false
      if (kindFilter !== 'all' && (r.kind ?? '') !== kindFilter) return false
      if (envFilter !== 'all' && (r.environment ?? '') !== envFilter) return false
      if (crownFilter === 'crown' && !r.is_crown_jewel) return false
      if (crownFilter === 'standard' && r.is_crown_jewel) return false
      return true
    })
  }, [resources, search, kindFilter, envFilter, crownFilter])

  const reachByResource = useMemo(() => {
    const map = new Map<string, ReachabilityEntry>()
    crown?.reachability?.forEach((e) => {
      if (e.resource_id) map.set(e.resource_id, e)
    })
    return map
  }, [crown])

  const stats = useMemo(() => {
    const crownCount = resources.filter((r) => r.is_crown_jewel).length
    const prod = resources.filter((r) => r.environment === 'production').length
    const kindsCount = new Set(resources.map((r) => r.kind).filter(Boolean)).size
    let reachableCrown = 0
    crown?.resources?.forEach((r) => {
      const entry = reachByResource.get(r.id)
      if (entry && ((entry.pipeline_count ?? 0) > 0 || (entry.reachable_via?.length ?? 0) > 0)) reachableCrown += 1
    })
    return { total: resources.length, crownCount, prod, kindsCount, reachableCrown }
  }, [resources, crown, reachByResource])

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAll = () => {
    setSelected((prev) => (prev.size === filtered.length ? new Set() : new Set(filtered.map((r) => r.id))))
  }

  const toggleCrown = async (r: Resource) => {
    setBusy(true)
    setError(null)
    try {
      await api.updateResource(r.id, {
        workspace_id: r.workspace_id,
        name: r.name,
        kind: r.kind,
        identifier: r.identifier,
        environment: r.environment,
        tags: r.tags ?? [],
        is_crown_jewel: !r.is_crown_jewel,
      })
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update resource')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this resource? This cannot be undone.')) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteResource(id)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete resource')
    } finally {
      setBusy(false)
    }
  }

  const bulkMarkCrown = async (value: boolean) => {
    if (selected.size === 0) return
    setBusy(true)
    setError(null)
    try {
      const byId = new Map(resources.map((r) => [r.id, r]))
      for (const id of selected) {
        const r = byId.get(id)
        if (!r) continue
        await api.updateResource(id, {
          workspace_id: r.workspace_id,
          name: r.name,
          kind: r.kind,
          identifier: r.identifier,
          environment: r.environment,
          tags: r.tags ?? [],
          is_crown_jewel: value,
        })
      }
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bulk update failed')
    } finally {
      setBusy(false)
    }
  }

  const bulkDelete = async () => {
    if (selected.size === 0) return
    if (!confirm(`Delete ${selected.size} resource(s)?`)) return
    setBusy(true)
    setError(null)
    try {
      for (const id of selected) await api.deleteResource(id)
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
          <h1 className="text-xl font-bold text-zinc-100">Resources &amp; Crown Jewels</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Catalog the cloud resources your pipelines can touch, flag the crown jewels, and see which are reachable
            from CI.
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
            + Add resource
          </Button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {!workspaceId && !loading && !error && (
        <EmptyState
          title="No workspace yet"
          description="Create or seed a workspace from the dashboard to start cataloging resources."
        />
      )}

      {workspaceId && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Resources" value={stats.total} />
            <Stat label="Crown jewels" value={stats.crownCount} accent={stats.crownCount ? 'red' : 'default'} />
            <Stat
              label="Reachable crown jewels"
              value={stats.reachableCrown}
              accent={stats.reachableCrown ? 'red' : 'emerald'}
              hint="Crown jewels exposed to a pipeline"
            />
            <Stat label="Production" value={stats.prod} accent={stats.prod ? 'amber' : 'default'} />
            <Stat label="Resource kinds" value={stats.kindsCount} accent="sky" />
          </div>

          {/* Crown-jewel reachability report */}
          <Card>
            <CardHeader>
              <CardTitle>Crown-jewel reachability</CardTitle>
            </CardHeader>
            <CardBody>
              {loading ? (
                <div className="flex justify-center py-8">
                  <Spinner label="Loading reachability..." />
                </div>
              ) : !crown || crown.resources.length === 0 ? (
                <p className="text-sm text-zinc-500">
                  No crown jewels flagged yet. Mark a resource as a crown jewel to surface its CI exposure here.
                </p>
              ) : (
                <div className="space-y-2">
                  {crown.resources.map((r) => {
                    const entry = reachByResource.get(r.id)
                    const pipelines = entry?.pipeline_count ?? entry?.reachable_via?.length ?? 0
                    const exposed = (pipelines as number) > 0
                    return (
                      <div
                        key={r.id}
                        className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3 ${
                          exposed ? 'border-red-800 bg-red-950/30' : 'border-zinc-800 bg-zinc-900/60'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span aria-hidden className="text-amber-400">
                            ◆
                          </span>
                          <div>
                            <div className="font-medium text-zinc-100">{r.name}</div>
                            <div className="font-mono text-xs text-zinc-500">{r.identifier || r.kind || '—'}</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          {r.environment && <Badge tone="info">{r.environment}</Badge>}
                          {exposed ? (
                            <Badge tone="critical">
                              reachable by {pipelines as number} pipeline{(pipelines as number) === 1 ? '' : 's'}
                            </Badge>
                          ) : (
                            <Badge tone="success">not reachable from CI</Badge>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, identifier, or kind..."
                  className="min-w-[200px] flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600"
                />
                <select
                  value={crownFilter}
                  onChange={(e) => setCrownFilter(e.target.value as CrownFilter)}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
                >
                  <option value="all">All resources</option>
                  <option value="crown">Crown jewels</option>
                  <option value="standard">Standard</option>
                </select>
                <select
                  value={kindFilter}
                  onChange={(e) => setKindFilter(e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
                >
                  <option value="all">All kinds</option>
                  {kinds.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <select
                  value={envFilter}
                  onChange={(e) => setEnvFilter(e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
                >
                  <option value="all">All environments</option>
                  {environments.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </div>

              {selected.size > 0 && (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900/80 px-4 py-2 text-sm">
                  <span className="text-zinc-400">{selected.size} selected</span>
                  <Button size="sm" variant="secondary" onClick={() => bulkMarkCrown(true)} disabled={busy}>
                    Mark crown jewel
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => bulkMarkCrown(false)} disabled={busy}>
                    Unmark crown jewel
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
                  <Spinner label="Loading resources..." />
                </div>
              ) : filtered.length === 0 ? (
                <EmptyState
                  title={resources.length === 0 ? 'No resources cataloged' : 'No resources match your filters'}
                  description={
                    resources.length === 0
                      ? 'Add a resource manually or sync a provider connection to discover the resources your pipelines reach.'
                      : 'Try clearing the search or filters.'
                  }
                  action={
                    resources.length === 0 ? (
                      <Button
                        onClick={() => {
                          setEditing(null)
                          setShowForm(true)
                        }}
                      >
                        + Add resource
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
                      <TH>Kind</TH>
                      <TH>Environment</TH>
                      <TH>Tags</TH>
                      <TH>Crown jewel</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {filtered.map((r) => (
                      <TR key={r.id}>
                        <TD>
                          <input
                            type="checkbox"
                            checked={selected.has(r.id)}
                            onChange={() => toggleSelect(r.id)}
                            aria-label={`Select ${r.name}`}
                          />
                        </TD>
                        <TD>
                          <div className="font-medium text-zinc-100">{r.name}</div>
                          {r.identifier && <div className="font-mono text-xs text-zinc-500">{r.identifier}</div>}
                        </TD>
                        <TD>
                          <span className="text-zinc-400">{r.kind || '—'}</span>
                        </TD>
                        <TD>{r.environment ? <Badge tone="info">{r.environment}</Badge> : <span className="text-zinc-600">—</span>}</TD>
                        <TD>
                          <div className="flex flex-wrap gap-1">
                            {(r.tags ?? []).slice(0, 4).map((t) => (
                              <Badge key={t} tone="neutral">
                                {t}
                              </Badge>
                            ))}
                            {(r.tags?.length ?? 0) > 4 && (
                              <span className="text-xs text-zinc-500">+{(r.tags?.length ?? 0) - 4}</span>
                            )}
                          </div>
                        </TD>
                        <TD>
                          <button
                            onClick={() => toggleCrown(r)}
                            disabled={busy}
                            className="inline-flex items-center gap-1 disabled:opacity-50"
                            aria-label={r.is_crown_jewel ? 'Unmark crown jewel' : 'Mark crown jewel'}
                          >
                            {r.is_crown_jewel ? (
                              <Badge tone="critical">◆ crown jewel</Badge>
                            ) : (
                              <Badge tone="neutral">mark crown</Badge>
                            )}
                          </button>
                        </TD>
                        <TD className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setEditing(r)
                                setShowForm(true)
                              }}
                            >
                              Edit
                            </Button>
                            <Button size="sm" variant="danger" onClick={() => remove(r.id)} disabled={busy}>
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

      {showForm && (
        <ResourceForm
          workspaceId={workspaceId}
          editing={editing}
          onClose={() => setShowForm(false)}
          onSaved={async () => {
            setShowForm(false)
            await reload()
          }}
        />
      )}
    </div>
  )
}

function ResourceForm({
  workspaceId,
  editing,
  onClose,
  onSaved,
}: {
  workspaceId: string
  editing: Resource | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(editing?.name ?? '')
  const [kind, setKind] = useState(editing?.kind ?? 's3_bucket')
  const [identifier, setIdentifier] = useState(editing?.identifier ?? '')
  const [environment, setEnvironment] = useState(editing?.environment ?? 'production')
  const [isCrownJewel, setIsCrownJewel] = useState(editing?.is_crown_jewel ?? false)
  const [tagsText, setTagsText] = useState((editing?.tags ?? []).join(', '))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (!name.trim()) {
      setErr('Name is required')
      return
    }
    setSaving(true)
    setErr(null)
    const tags = tagsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const body = {
      workspace_id: workspaceId,
      name: name.trim(),
      kind,
      identifier: identifier.trim() || null,
      environment,
      is_crown_jewel: isCrownJewel,
      tags,
    }
    try {
      if (editing) await api.updateResource(editing.id, body)
      else await api.createResource(body)
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save resource')
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Edit resource' : 'Add resource'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Saving...' : editing ? 'Save changes' : 'Add resource'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {err && (
          <div className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-300">{err}</div>
        )}
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="prod-artifacts"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">Kind</label>
            <select
              value={kind ?? ''}
              onChange={(e) => setKind(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">Environment</label>
            <select
              value={environment ?? ''}
              onChange={(e) => setEnvironment(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
            >
              {ENVIRONMENTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">Identifier (ARN / URN)</label>
          <input
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="arn:aws:s3:::prod-artifacts"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-mono text-zinc-200"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">Tags (comma-separated)</label>
          <input
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="pci, customer-data"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
          />
        </div>
        <label
          className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
            isCrownJewel ? 'border-red-800 bg-red-950/40 text-red-300' : 'border-zinc-700 bg-zinc-900 text-zinc-300'
          }`}
        >
          <input type="checkbox" checked={isCrownJewel} onChange={(e) => setIsCrownJewel(e.target.checked)} />
          Crown jewel (high-value asset)
        </label>
      </div>
    </Modal>
  )
}
