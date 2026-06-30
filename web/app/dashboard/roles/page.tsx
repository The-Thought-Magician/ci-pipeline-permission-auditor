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

interface Role {
  id: string
  workspace_id: string
  name: string
  cloud: string | null
  arn: string | null
  policy_summary: unknown
  is_privileged: boolean
  created_at: string
}

interface Permission {
  id: string
  workspace_id: string
  role_id: string | null
  identity_id: string | null
  resource_id: string | null
  action: string
  effect: string
  category: string | null
  is_declared: boolean
  is_wildcard: boolean
  created_at: string
}

interface RoleDetail extends Role {
  permissions?: Permission[]
}

const WS_KEY = 'cppa.workspaceId'

const CLOUDS = ['aws', 'gcp', 'azure', 'kubernetes', 'github', 'other']
const EFFECTS = ['allow', 'deny']
const CATEGORIES = ['read', 'write', 'admin', 'delete', 'list', 'compute', 'identity', 'network', 'other']

type CloudFilter = 'all' | string
type PrivFilter = 'all' | 'privileged' | 'standard'

export default function RolesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState<string>('')
  const [roles, setRoles] = useState<Role[]>([])
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [search, setSearch] = useState('')
  const [cloudFilter, setCloudFilter] = useState<CloudFilter>('all')
  const [privFilter, setPrivFilter] = useState<PrivFilter>('all')

  const [showRoleForm, setShowRoleForm] = useState(false)
  const [editingRole, setEditingRole] = useState<Role | null>(null)

  const [detail, setDetail] = useState<RoleDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [showPermForm, setShowPermForm] = useState(false)
  const [editingPerm, setEditingPerm] = useState<Permission | null>(null)
  const [permRoleId, setPermRoleId] = useState<string>('')

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
      const [r, p] = await Promise.all([
        api.listRoles(workspaceId) as Promise<Role[]>,
        api.listPermissions(workspaceId) as Promise<Permission[]>,
      ])
      setRoles(r || [])
      setPermissions(p || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load roles')
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

  const permsByRole = useMemo(() => {
    const map = new Map<string, Permission[]>()
    permissions.forEach((p) => {
      if (!p.role_id) return
      const arr = map.get(p.role_id) ?? []
      arr.push(p)
      map.set(p.role_id, arr)
    })
    return map
  }, [permissions])

  const clouds = useMemo(() => {
    const set = new Set<string>()
    roles.forEach((r) => r.cloud && set.add(r.cloud))
    return Array.from(set).sort()
  }, [roles])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return roles.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !(r.arn ?? '').toLowerCase().includes(q)) return false
      if (cloudFilter !== 'all' && (r.cloud ?? '') !== cloudFilter) return false
      if (privFilter === 'privileged' && !r.is_privileged) return false
      if (privFilter === 'standard' && r.is_privileged) return false
      return true
    })
  }, [roles, search, cloudFilter, privFilter])

  const stats = useMemo(() => {
    const privileged = roles.filter((r) => r.is_privileged).length
    const wildcardPerms = permissions.filter((p) => p.is_wildcard).length
    const denyPerms = permissions.filter((p) => p.effect === 'deny').length
    return {
      roles: roles.length,
      privileged,
      permissions: permissions.length,
      wildcardPerms,
      denyPerms,
    }
  }, [roles, permissions])

  const openDetail = async (id: string) => {
    setDetail(null)
    setDetailLoading(true)
    try {
      const d: RoleDetail = await api.getRole(id)
      setDetail(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load role detail')
    } finally {
      setDetailLoading(false)
    }
  }

  const togglePrivileged = async (r: Role) => {
    setBusy(true)
    setError(null)
    try {
      await api.updateRole(r.id, {
        workspace_id: r.workspace_id,
        name: r.name,
        cloud: r.cloud,
        arn: r.arn,
        policy_summary: r.policy_summary ?? null,
        is_privileged: !r.is_privileged,
      })
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update role')
    } finally {
      setBusy(false)
    }
  }

  const removeRole = async (id: string) => {
    if (!confirm('Delete this role and detach its permissions? This cannot be undone.')) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteRole(id)
      if (detail?.id === id) setDetail(null)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete role')
    } finally {
      setBusy(false)
    }
  }

  const removePerm = async (id: string) => {
    if (!confirm('Delete this permission?')) return
    setBusy(true)
    setError(null)
    try {
      await api.deletePermission(id)
      await reload()
      if (detail) await openDetail(detail.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete permission')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-zinc-100">Roles &amp; Permissions</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Inventory the cloud roles your pipelines assume, the permissions attached to them, and which roles carry
            privileged or wildcard access.
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
            variant="secondary"
            onClick={() => {
              setEditingPerm(null)
              setPermRoleId(roles[0]?.id ?? '')
              setShowPermForm(true)
            }}
            disabled={!workspaceId || roles.length === 0}
          >
            + Add permission
          </Button>
          <Button
            onClick={() => {
              setEditingRole(null)
              setShowRoleForm(true)
            }}
            disabled={!workspaceId}
          >
            + Add role
          </Button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {!workspaceId && !loading && !error && (
        <EmptyState
          title="No workspace yet"
          description="Create or seed a workspace from the dashboard to start cataloging roles."
        />
      )}

      {workspaceId && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Roles" value={stats.roles} />
            <Stat label="Privileged" value={stats.privileged} accent={stats.privileged ? 'red' : 'emerald'} />
            <Stat label="Permissions" value={stats.permissions} accent="sky" />
            <Stat
              label="Wildcard perms"
              value={stats.wildcardPerms}
              accent={stats.wildcardPerms ? 'red' : 'emerald'}
              hint="Actions with *"
            />
            <Stat label="Explicit denies" value={stats.denyPerms} accent="amber" />
          </div>

          <Card>
            <CardBody className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name or ARN..."
                  className="min-w-[200px] flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600"
                />
                <select
                  value={privFilter}
                  onChange={(e) => setPrivFilter(e.target.value as PrivFilter)}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
                >
                  <option value="all">All roles</option>
                  <option value="privileged">Privileged</option>
                  <option value="standard">Standard</option>
                </select>
                <select
                  value={cloudFilter}
                  onChange={(e) => setCloudFilter(e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
                >
                  <option value="all">All clouds</option>
                  {clouds.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              {loading ? (
                <div className="flex justify-center py-16">
                  <Spinner label="Loading roles..." />
                </div>
              ) : filtered.length === 0 ? (
                <EmptyState
                  title={roles.length === 0 ? 'No roles cataloged' : 'No roles match your filters'}
                  description={
                    roles.length === 0
                      ? 'Add a cloud role manually or sync a provider connection to discover the roles your pipelines assume.'
                      : 'Try clearing the search or filters.'
                  }
                  action={
                    roles.length === 0 ? (
                      <Button
                        onClick={() => {
                          setEditingRole(null)
                          setShowRoleForm(true)
                        }}
                      >
                        + Add role
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Role</TH>
                      <TH>Cloud</TH>
                      <TH>Permissions</TH>
                      <TH>Flags</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {filtered.map((r) => {
                      const perms = permsByRole.get(r.id) ?? []
                      const wildcard = perms.some((p) => p.is_wildcard)
                      return (
                        <TR key={r.id}>
                          <TD>
                            <button
                              className="font-medium text-zinc-100 hover:text-red-400"
                              onClick={() => openDetail(r.id)}
                            >
                              {r.name}
                            </button>
                            {r.arn && <div className="font-mono text-xs text-zinc-500">{r.arn}</div>}
                          </TD>
                          <TD>{r.cloud ? <Badge tone="info">{r.cloud}</Badge> : <span className="text-zinc-600">—</span>}</TD>
                          <TD>
                            <span className="text-zinc-300">{perms.length}</span>
                          </TD>
                          <TD>
                            <div className="flex flex-wrap gap-1">
                              {r.is_privileged && <Badge tone="critical">privileged</Badge>}
                              {wildcard && <Badge tone="high">wildcard</Badge>}
                              {!r.is_privileged && !wildcard && <Badge tone="success">scoped</Badge>}
                            </div>
                          </TD>
                          <TD className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  setEditingPerm(null)
                                  setPermRoleId(r.id)
                                  setShowPermForm(true)
                                }}
                              >
                                + Perm
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => togglePrivileged(r)} disabled={busy}>
                                {r.is_privileged ? 'Unmark priv' : 'Mark priv'}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setEditingRole(r)
                                  setShowRoleForm(true)
                                }}
                              >
                                Edit
                              </Button>
                              <Button size="sm" variant="danger" onClick={() => removeRole(r.id)} disabled={busy}>
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

      {showRoleForm && (
        <RoleForm
          workspaceId={workspaceId}
          editing={editingRole}
          onClose={() => setShowRoleForm(false)}
          onSaved={async () => {
            setShowRoleForm(false)
            await reload()
          }}
        />
      )}

      {showPermForm && (
        <PermissionForm
          workspaceId={workspaceId}
          roles={roles}
          defaultRoleId={permRoleId}
          editing={editingPerm}
          onClose={() => setShowPermForm(false)}
          onSaved={async () => {
            setShowPermForm(false)
            await reload()
            if (detail) await openDetail(detail.id)
          }}
        />
      )}

      <Modal open={!!detail || detailLoading} onClose={() => setDetail(null)} title="Role detail" size="lg">
        {detailLoading ? (
          <div className="flex justify-center py-8">
            <Spinner label="Loading..." />
          </div>
        ) : detail ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-lg font-semibold text-zinc-100">{detail.name}</div>
                {detail.arn && <div className="font-mono text-xs text-zinc-500">{detail.arn}</div>}
              </div>
              <div className="flex flex-wrap gap-2">
                {detail.cloud && <Badge tone="info">{detail.cloud}</Badge>}
                {detail.is_privileged && <Badge tone="critical">privileged</Badge>}
              </div>
            </div>

            {detail.policy_summary != null && (
              <div>
                <div className="mb-1 text-xs uppercase text-zinc-500">Policy summary</div>
                <pre className="max-h-48 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300">
                  {typeof detail.policy_summary === 'string'
                    ? detail.policy_summary
                    : JSON.stringify(detail.policy_summary, null, 2)}
                </pre>
              </div>
            )}

            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs uppercase text-zinc-500">
                  Attached permissions ({detail.permissions?.length ?? 0})
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setEditingPerm(null)
                    setPermRoleId(detail.id)
                    setShowPermForm(true)
                  }}
                >
                  + Add permission
                </Button>
              </div>
              {detail.permissions && detail.permissions.length > 0 ? (
                <div className="space-y-1">
                  {detail.permissions.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <Badge tone={p.effect === 'deny' ? 'success' : p.is_wildcard ? 'critical' : 'neutral'}>
                          {p.effect}
                        </Badge>
                        <span className="font-mono text-xs text-zinc-200">{p.action}</span>
                        {p.is_wildcard && <Badge tone="high">wildcard</Badge>}
                        {p.category && <span className="text-xs text-zinc-500">{p.category}</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          className="text-xs text-zinc-400 hover:text-zinc-100"
                          onClick={() => {
                            setEditingPerm(p)
                            setPermRoleId(p.role_id ?? detail.id)
                            setShowPermForm(true)
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="text-xs text-red-400 hover:text-red-300"
                          onClick={() => removePerm(p.id)}
                          disabled={busy}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No permissions attached to this role yet.</p>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

function RoleForm({
  workspaceId,
  editing,
  onClose,
  onSaved,
}: {
  workspaceId: string
  editing: Role | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(editing?.name ?? '')
  const [cloud, setCloud] = useState(editing?.cloud ?? 'aws')
  const [arn, setArn] = useState(editing?.arn ?? '')
  const [isPrivileged, setIsPrivileged] = useState(editing?.is_privileged ?? false)
  const [policyText, setPolicyText] = useState(
    editing?.policy_summary
      ? typeof editing.policy_summary === 'string'
        ? editing.policy_summary
        : JSON.stringify(editing.policy_summary, null, 2)
      : '',
  )
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (!name.trim()) {
      setErr('Name is required')
      return
    }
    let policy_summary: unknown = null
    if (policyText.trim()) {
      try {
        policy_summary = JSON.parse(policyText)
      } catch {
        policy_summary = policyText.trim()
      }
    }
    setSaving(true)
    setErr(null)
    const body = {
      workspace_id: workspaceId,
      name: name.trim(),
      cloud,
      arn: arn.trim() || null,
      is_privileged: isPrivileged,
      policy_summary,
    }
    try {
      if (editing) await api.updateRole(editing.id, body)
      else await api.createRole(body)
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save role')
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Edit role' : 'Add role'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Saving...' : editing ? 'Save changes' : 'Add role'}
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
            placeholder="gha-deploy-prod"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">Cloud</label>
          <select
            value={cloud ?? ''}
            onChange={(e) => setCloud(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
          >
            {CLOUDS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">ARN / resource id</label>
          <input
            value={arn}
            onChange={(e) => setArn(e.target.value)}
            placeholder="arn:aws:iam::123456789012:role/gha-deploy-prod"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-mono text-zinc-200"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">Policy summary (JSON or text)</label>
          <textarea
            value={policyText}
            onChange={(e) => setPolicyText(e.target.value)}
            rows={4}
            placeholder='{"statements": 3, "services": ["s3", "ecr"]}'
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-mono text-zinc-200"
          />
        </div>
        <label
          className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
            isPrivileged ? 'border-red-800 bg-red-950/40 text-red-300' : 'border-zinc-700 bg-zinc-900 text-zinc-300'
          }`}
        >
          <input type="checkbox" checked={isPrivileged} onChange={(e) => setIsPrivileged(e.target.checked)} />
          Privileged role (admin / broad access)
        </label>
      </div>
    </Modal>
  )
}

function PermissionForm({
  workspaceId,
  roles,
  defaultRoleId,
  editing,
  onClose,
  onSaved,
}: {
  workspaceId: string
  roles: Role[]
  defaultRoleId: string
  editing: Permission | null
  onClose: () => void
  onSaved: () => void
}) {
  const [roleId, setRoleId] = useState(editing?.role_id ?? defaultRoleId ?? '')
  const [action, setAction] = useState(editing?.action ?? '')
  const [effect, setEffect] = useState(editing?.effect ?? 'allow')
  const [category, setCategory] = useState(editing?.category ?? 'read')
  const [isWildcard, setIsWildcard] = useState(editing?.is_wildcard ?? false)
  const [isDeclared, setIsDeclared] = useState(editing?.is_declared ?? true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (!roleId) {
      setErr('A role is required')
      return
    }
    if (!action.trim()) {
      setErr('Action is required')
      return
    }
    setSaving(true)
    setErr(null)
    const wildcard = isWildcard || action.includes('*')
    const body = {
      workspace_id: workspaceId,
      role_id: roleId,
      action: action.trim(),
      effect,
      category,
      is_wildcard: wildcard,
      is_declared: isDeclared,
    }
    try {
      if (editing) await api.updatePermission(editing.id, body)
      else await api.createPermission(body)
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save permission')
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Edit permission' : 'Add permission'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Saving...' : editing ? 'Save changes' : 'Add permission'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {err && (
          <div className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-300">{err}</div>
        )}
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">Role</label>
          <select
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
          >
            <option value="">Select a role...</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">Action</label>
          <input
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="s3:PutObject"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-mono text-zinc-200"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">Effect</label>
            <select
              value={effect}
              onChange={(e) => setEffect(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
            >
              {EFFECTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">Category</label>
            <select
              value={category ?? ''}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label
            className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
              isWildcard ? 'border-red-800 bg-red-950/40 text-red-300' : 'border-zinc-700 bg-zinc-900 text-zinc-300'
            }`}
          >
            <input type="checkbox" checked={isWildcard} onChange={(e) => setIsWildcard(e.target.checked)} />
            Wildcard action
          </label>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-300">
            <input type="checkbox" checked={isDeclared} onChange={(e) => setIsDeclared(e.target.checked)} />
            Declared in policy
          </label>
        </div>
      </div>
    </Modal>
  )
}
