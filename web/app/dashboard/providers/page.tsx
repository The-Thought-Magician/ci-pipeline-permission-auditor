'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'

interface Workspace {
  id: string
  name: string
}

interface Provider {
  id: string
  workspace_id: string
  kind: string
  name: string
  base_url?: string | null
  org?: string | null
  status?: string | null
  created_at?: string
}

interface Connection {
  id: string
  workspace_id: string
  provider_id: string
  label: string
  scope?: string | null
  status?: string | null
  last_synced_at?: string | null
  last_error?: string | null
  config?: unknown
  created_at?: string
}

const PROVIDER_KINDS = ['github', 'gitlab', 'jenkins', 'circleci', 'azure_devops', 'bitbucket']

function statusTone(status?: string | null): 'success' | 'critical' | 'warning' | 'neutral' {
  switch ((status ?? '').toLowerCase()) {
    case 'active':
    case 'connected':
    case 'ok':
    case 'synced':
      return 'success'
    case 'error':
    case 'failed':
      return 'critical'
    case 'syncing':
    case 'pending':
      return 'warning'
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

export default function ProvidersPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [providers, setProviders] = useState<Provider[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [search, setSearch] = useState('')

  const [providerModal, setProviderModal] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [pForm, setPForm] = useState({ kind: 'github', name: '', base_url: '', org: '', status: 'active' })

  const [connModal, setConnModal] = useState(false)
  const [cForm, setCForm] = useState({ provider_id: '', label: '', scope: '' })

  const loadScoped = useCallback(async (wsId: string) => {
    const [prov, conn] = await Promise.all([api.listProviders(wsId), api.listConnections(wsId)])
    setProviders(Array.isArray(prov) ? prov : [])
    setConnections(Array.isArray(conn) ? conn : [])
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
      setError(e?.message ?? 'Failed to load providers')
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

  const providerName = useCallback(
    (id: string) => providers.find((p) => p.id === id)?.name ?? 'Unknown provider',
    [providers],
  )

  // ---- Provider CRUD ----
  const openCreateProvider = () => {
    setEditingProvider(null)
    setPForm({ kind: 'github', name: '', base_url: '', org: '', status: 'active' })
    setProviderModal(true)
  }
  const openEditProvider = (p: Provider) => {
    setEditingProvider(p)
    setPForm({
      kind: p.kind ?? 'github',
      name: p.name ?? '',
      base_url: p.base_url ?? '',
      org: p.org ?? '',
      status: p.status ?? 'active',
    })
    setProviderModal(true)
  }
  const saveProvider = async () => {
    if (!pForm.name.trim()) {
      setError('Provider name is required')
      return
    }
    setBusy('provider')
    setError(null)
    try {
      if (editingProvider) {
        await api.updateProvider(editingProvider.id, {
          kind: pForm.kind,
          name: pForm.name.trim(),
          base_url: pForm.base_url || null,
          org: pForm.org || null,
          status: pForm.status,
        })
      } else {
        await api.createProvider({
          workspace_id: workspaceId,
          kind: pForm.kind,
          name: pForm.name.trim(),
          base_url: pForm.base_url || null,
          org: pForm.org || null,
          status: pForm.status,
        })
      }
      setProviderModal(false)
      await loadScoped(workspaceId)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save provider')
    } finally {
      setBusy(null)
    }
  }
  const deleteProvider = async (p: Provider) => {
    if (!confirm(`Delete provider "${p.name}"? Connections under it may also be removed.`)) return
    setBusy(`del-prov-${p.id}`)
    setError(null)
    try {
      await api.deleteProvider(p.id)
      await loadScoped(workspaceId)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to delete provider')
    } finally {
      setBusy(null)
    }
  }

  // ---- Connection CRUD ----
  const openCreateConnection = (presetProvider?: string) => {
    setCForm({ provider_id: presetProvider ?? providers[0]?.id ?? '', label: '', scope: '' })
    setConnModal(true)
  }
  const saveConnection = async () => {
    if (!cForm.provider_id) {
      setError('Select a provider for the connection')
      return
    }
    if (!cForm.label.trim()) {
      setError('Connection label is required')
      return
    }
    setBusy('connection')
    setError(null)
    try {
      await api.createConnection({
        workspace_id: workspaceId,
        provider_id: cForm.provider_id,
        label: cForm.label.trim(),
        scope: cForm.scope || null,
      })
      setConnModal(false)
      await loadScoped(workspaceId)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to create connection')
    } finally {
      setBusy(null)
    }
  }
  const syncConnection = async (c: Connection) => {
    setBusy(`sync-${c.id}`)
    setError(null)
    try {
      await api.syncConnection(c.id)
      await loadScoped(workspaceId)
    } catch (e: any) {
      setError(e?.message ?? 'Sync failed')
    } finally {
      setBusy(null)
    }
  }
  const deleteConnection = async (c: Connection) => {
    if (!confirm(`Delete connection "${c.label}"?`)) return
    setBusy(`del-conn-${c.id}`)
    setError(null)
    try {
      await api.deleteConnection(c.id)
      await loadScoped(workspaceId)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to delete connection')
    } finally {
      setBusy(null)
    }
  }

  const filteredProviders = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return providers
    return providers.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.kind.toLowerCase().includes(q) ||
        (p.org ?? '').toLowerCase().includes(q),
    )
  }, [providers, search])

  const isEmpty = workspaces.length === 0

  if (loading && providers.length === 0 && connections.length === 0 && !isEmpty) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner label="Loading providers..." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-100">Providers & Connections</h1>
          <p className="mt-1 text-sm text-zinc-500">SCM/CI providers and the ingestion runs that populate your inventory.</p>
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
          description="Create or seed a workspace from the dashboard before configuring providers."
        />
      ) : (
        <>
          {/* Providers */}
          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Provider Connections</CardTitle>
              <div className="flex items-center gap-2">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search providers..."
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-500/60"
                />
                <Button size="sm" variant="secondary" onClick={refresh} disabled={loading}>
                  Refresh
                </Button>
                <Button size="sm" onClick={openCreateProvider}>
                  Add provider
                </Button>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              {filteredProviders.length === 0 ? (
                <div className="p-6">
                  <EmptyState
                    title="No providers"
                    description="Add a GitHub, GitLab, Jenkins, or other CI provider to start ingesting pipelines."
                    action={<Button onClick={openCreateProvider}>Add provider</Button>}
                  />
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Name</TH>
                      <TH>Kind</TH>
                      <TH>Org</TH>
                      <TH>Base URL</TH>
                      <TH>Status</TH>
                      <TH>Connections</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {filteredProviders.map((p) => {
                      const connCount = connections.filter((c) => c.provider_id === p.id).length
                      return (
                        <TR key={p.id}>
                          <TD className="font-medium text-zinc-100">{p.name}</TD>
                          <TD>
                            <Badge tone="info">{p.kind}</Badge>
                          </TD>
                          <TD>{p.org || '—'}</TD>
                          <TD className="max-w-[200px] truncate text-zinc-500">{p.base_url || '—'}</TD>
                          <TD>
                            <Badge tone={statusTone(p.status)}>{p.status || 'unknown'}</Badge>
                          </TD>
                          <TD>{connCount}</TD>
                          <TD className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button size="sm" variant="ghost" onClick={() => openCreateConnection(p.id)}>
                                + Connection
                              </Button>
                              <Button size="sm" variant="secondary" onClick={() => openEditProvider(p)}>
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => deleteProvider(p)}
                                disabled={busy === `del-prov-${p.id}`}
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

          {/* Connections / ingestion runs */}
          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Ingestion Runs</CardTitle>
              <Button size="sm" onClick={() => openCreateConnection()} disabled={providers.length === 0}>
                Add connection
              </Button>
            </CardHeader>
            <CardBody className="p-0">
              {connections.length === 0 ? (
                <div className="p-6">
                  <EmptyState
                    title="No connections"
                    description="Add a connection to a provider, then sync it to deterministically populate pipelines, identities, actions, and secrets."
                  />
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Label</TH>
                      <TH>Provider</TH>
                      <TH>Scope</TH>
                      <TH>Status</TH>
                      <TH>Last synced</TH>
                      <TH>Last error</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {connections.map((c) => (
                      <TR key={c.id}>
                        <TD className="font-medium text-zinc-100">{c.label}</TD>
                        <TD>{providerName(c.provider_id)}</TD>
                        <TD className="text-zinc-500">{c.scope || '—'}</TD>
                        <TD>
                          <Badge tone={statusTone(c.status)}>{c.status || 'idle'}</Badge>
                        </TD>
                        <TD className="text-zinc-500">{fmtDate(c.last_synced_at)}</TD>
                        <TD className="max-w-[200px] truncate text-red-400">{c.last_error || '—'}</TD>
                        <TD className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              onClick={() => syncConnection(c)}
                              disabled={busy === `sync-${c.id}`}
                            >
                              {busy === `sync-${c.id}` ? 'Syncing...' : 'Sync now'}
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => deleteConnection(c)}
                              disabled={busy === `del-conn-${c.id}`}
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

      {/* Provider modal */}
      <Modal
        open={providerModal}
        onClose={() => setProviderModal(false)}
        title={editingProvider ? 'Edit provider' : 'Add provider'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setProviderModal(false)}>
              Cancel
            </Button>
            <Button onClick={saveProvider} disabled={busy === 'provider'}>
              {busy === 'provider' ? 'Saving...' : editingProvider ? 'Save changes' : 'Create provider'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Kind">
            <select
              value={pForm.kind}
              onChange={(e) => setPForm({ ...pForm, kind: e.target.value })}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-500/60"
            >
              {PROVIDER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name">
            <TextInput value={pForm.name} onChange={(v) => setPForm({ ...pForm, name: v })} placeholder="Production GitHub" />
          </Field>
          <Field label="Org / namespace">
            <TextInput value={pForm.org} onChange={(v) => setPForm({ ...pForm, org: v })} placeholder="acme-corp" />
          </Field>
          <Field label="Base URL">
            <TextInput
              value={pForm.base_url}
              onChange={(v) => setPForm({ ...pForm, base_url: v })}
              placeholder="https://github.com"
            />
          </Field>
          <Field label="Status">
            <select
              value={pForm.status}
              onChange={(e) => setPForm({ ...pForm, status: e.target.value })}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-500/60"
            >
              {['active', 'paused', 'error'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Modal>

      {/* Connection modal */}
      <Modal
        open={connModal}
        onClose={() => setConnModal(false)}
        title="Add connection"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConnModal(false)}>
              Cancel
            </Button>
            <Button onClick={saveConnection} disabled={busy === 'connection'}>
              {busy === 'connection' ? 'Creating...' : 'Create connection'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Provider">
            <select
              value={cForm.provider_id}
              onChange={(e) => setCForm({ ...cForm, provider_id: e.target.value })}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-500/60"
            >
              <option value="">Select a provider</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.kind})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Label">
            <TextInput value={cForm.label} onChange={(v) => setCForm({ ...cForm, label: v })} placeholder="acme-corp org sync" />
          </Field>
          <Field label="Scope">
            <TextInput
              value={cForm.scope}
              onChange={(v) => setCForm({ ...cForm, scope: v })}
              placeholder="org:acme-corp or repo:acme/api"
            />
          </Field>
          <p className="text-xs text-zinc-500">
            After creating, use Sync now to deterministically ingest pipelines, identities, actions, and secrets.
          </p>
        </div>
      </Modal>
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
