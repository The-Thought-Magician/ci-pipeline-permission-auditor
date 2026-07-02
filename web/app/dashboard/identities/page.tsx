'use client'

import { useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Stat } from '@/components/ui/Stat'
import { Modal } from '@/components/ui/Modal'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'

interface Identity {
  id: string
  name: string
  identity_type?: string
  credential_kind?: string
  is_long_lived?: boolean
  environment?: string
  tags?: unknown
  last_active_at?: string | null
}

interface OidcTrust {
  id: string
  identity_id: string
  issuer: string
  audience?: string
  sub_claim_pattern?: string
  is_branch_scoped?: boolean
  assumable_role_ids?: unknown
}

const blankIdentity = {
  name: '',
  identity_type: 'workload',
  credential_kind: 'oidc',
  is_long_lived: false,
  environment: 'production',
}

const blankTrust = {
  identity_id: '',
  issuer: 'https://token.actions.githubusercontent.com',
  audience: 'sts.amazonaws.com',
  sub_claim_pattern: 'repo:org/*:ref:refs/heads/main',
  is_branch_scoped: true,
}

function fieldClass() {
  return 'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:border-red-500 focus:outline-none'
}

export default function IdentitiesPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [identities, setIdentities] = useState<Identity[]>([])
  const [trusts, setTrusts] = useState<OidcTrust[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'identities' | 'oidc'>('identities')
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)

  // Identity modal
  const [idModal, setIdModal] = useState(false)
  const [editIdentity, setEditIdentity] = useState<Identity | null>(null)
  const [idForm, setIdForm] = useState({ ...blankIdentity })

  // Trust modal
  const [trustModal, setTrustModal] = useState(false)
  const [editTrust, setEditTrust] = useState<OidcTrust | null>(null)
  const [trustForm, setTrustForm] = useState({ ...blankTrust })

  async function load(wsId: string) {
    setError(null)
    const [ids, ts] = await Promise.all([api.listIdentities(wsId), api.listOidcTrusts(wsId)])
    setIdentities(Array.isArray(ids) ? ids : [])
    setTrusts(Array.isArray(ts) ? ts : [])
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const ws = await api.listWorkspaces()
        const first = Array.isArray(ws) && ws.length > 0 ? ws[0] : null
        if (cancelled) return
        if (!first) {
          setLoading(false)
          return
        }
        setWorkspaceId(first.id)
        await load(first.id)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const identityName = useMemo(() => {
    const m = new Map<string, string>()
    identities.forEach((i) => m.set(i.id, i.name))
    return m
  }, [identities])

  // ---- Identity CRUD ----
  function openCreateIdentity() {
    setEditIdentity(null)
    setIdForm({ ...blankIdentity })
    setIdModal(true)
  }
  function openEditIdentity(i: Identity) {
    setEditIdentity(i)
    setIdForm({
      name: i.name ?? '',
      identity_type: i.identity_type ?? 'workload',
      credential_kind: i.credential_kind ?? 'oidc',
      is_long_lived: !!i.is_long_lived,
      environment: i.environment ?? 'production',
    })
    setIdModal(true)
  }
  async function saveIdentity() {
    if (!workspaceId) return
    setSaving(true)
    setError(null)
    try {
      if (editIdentity) {
        await api.updateIdentity(editIdentity.id, idForm)
      } else {
        await api.createIdentity({ workspace_id: workspaceId, ...idForm })
      }
      await load(workspaceId)
      setIdModal(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }
  async function removeIdentity(i: Identity) {
    if (!workspaceId) return
    if (!confirm(`Delete identity "${i.name}"? This also removes its OIDC trusts.`)) return
    setError(null)
    try {
      await api.deleteIdentity(i.id)
      await load(workspaceId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  // ---- OIDC trust CRUD ----
  function openCreateTrust() {
    setEditTrust(null)
    setTrustForm({ ...blankTrust, identity_id: identities[0]?.id ?? '' })
    setTrustModal(true)
  }
  function openEditTrust(t: OidcTrust) {
    setEditTrust(t)
    setTrustForm({
      identity_id: t.identity_id,
      issuer: t.issuer ?? '',
      audience: t.audience ?? '',
      sub_claim_pattern: t.sub_claim_pattern ?? '',
      is_branch_scoped: !!t.is_branch_scoped,
    })
    setTrustModal(true)
  }
  async function saveTrust() {
    if (!workspaceId) return
    setSaving(true)
    setError(null)
    try {
      if (editTrust) {
        await api.updateOidcTrust(editTrust.id, trustForm)
      } else {
        await api.createOidcTrust({ workspace_id: workspaceId, ...trustForm })
      }
      await load(workspaceId)
      setTrustModal(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }
  async function removeTrust(t: OidcTrust) {
    if (!workspaceId) return
    if (!confirm('Delete this OIDC trust?')) return
    setError(null)
    try {
      await api.deleteOidcTrust(t.id)
      await load(workspaceId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  const filteredIdentities = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return identities
    return identities.filter((i) =>
      `${i.name} ${i.identity_type ?? ''} ${i.environment ?? ''} ${i.credential_kind ?? ''}`
        .toLowerCase()
        .includes(q),
    )
  }, [identities, search])

  const filteredTrusts = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return trusts
    return trusts.filter((t) =>
      `${t.issuer} ${t.audience ?? ''} ${t.sub_claim_pattern ?? ''} ${identityName.get(t.identity_id) ?? ''}`
        .toLowerCase()
        .includes(q),
    )
  }, [trusts, search, identityName])

  const longLived = identities.filter((i) => i.is_long_lived).length
  const looseTrusts = trusts.filter(
    (t) => !t.is_branch_scoped || (t.sub_claim_pattern ?? '').includes('*'),
  ).length

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner label="Loading identities..." />
      </div>
    )
  }

  if (!workspaceId) {
    return (
      <div className="mx-auto max-w-3xl py-12">
        <EmptyState
          title="No workspace found"
          description="Create a workspace and seed sample data from the dashboard first."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100">Identities &amp; OIDC Trusts</h1>
          <p className="mt-1 text-sm text-slate-500">
            Workload identities used by pipelines and the OIDC trust relationships that let them assume cloud roles.
          </p>
        </div>
        {tab === 'identities' ? (
          <Button onClick={openCreateIdentity}>New identity</Button>
        ) : (
          <Button onClick={openCreateTrust} disabled={identities.length === 0}>
            New OIDC trust
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Identities" value={identities.length} />
        <Stat
          label="Long-lived"
          value={longLived}
          accent={longLived > 0 ? 'red' : 'emerald'}
          hint="static credentials"
        />
        <Stat label="OIDC trusts" value={trusts.length} accent="sky" />
        <Stat
          label="Loose trusts"
          value={looseTrusts}
          accent={looseTrusts > 0 ? 'amber' : 'emerald'}
          hint="wildcard / not branch-scoped"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-slate-800 bg-slate-900/60 p-1">
          <button
            onClick={() => setTab('identities')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${
              tab === 'identities' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Identities ({identities.length})
          </button>
          <button
            onClick={() => setTab('oidc')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${
              tab === 'oidc' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            OIDC Trusts ({trusts.length})
          </button>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search..."
          className="ml-auto rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:border-red-500 focus:outline-none"
        />
      </div>

      {tab === 'identities' ? (
        <Card>
          <CardBody className="p-0">
            {filteredIdentities.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title={identities.length === 0 ? 'No identities yet' : 'No matches'}
                  description={
                    identities.length === 0
                      ? 'Add a workload identity or seed sample data to get started.'
                      : 'Try a different search.'
                  }
                  action={
                    identities.length === 0 ? (
                      <Button onClick={openCreateIdentity}>New identity</Button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Type</TH>
                    <TH>Credential</TH>
                    <TH>Environment</TH>
                    <TH>Trusts</TH>
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {filteredIdentities.map((i) => {
                    const trustCount = trusts.filter((t) => t.identity_id === i.id).length
                    return (
                      <TR key={i.id}>
                        <TD className="font-medium text-slate-200">{i.name}</TD>
                        <TD>
                          <Badge tone="info">{i.identity_type ?? 'unknown'}</Badge>
                        </TD>
                        <TD>
                          <span className="font-mono text-xs">{i.credential_kind ?? '-'}</span>
                          {i.is_long_lived && (
                            <Badge tone="critical" className="ml-2">
                              long-lived
                            </Badge>
                          )}
                        </TD>
                        <TD>{i.environment ?? '-'}</TD>
                        <TD>{trustCount}</TD>
                        <TD className="text-right">
                          <div className="inline-flex gap-2">
                            <Button size="sm" variant="secondary" onClick={() => openEditIdentity(i)}>
                              Edit
                            </Button>
                            <Button size="sm" variant="danger" onClick={() => removeIdentity(i)}>
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
      ) : (
        <Card>
          <CardBody className="p-0">
            {filteredTrusts.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title={trusts.length === 0 ? 'No OIDC trusts yet' : 'No matches'}
                  description={
                    identities.length === 0
                      ? 'Create an identity first, then configure an OIDC trust for it.'
                      : trusts.length === 0
                        ? 'Add a trust relationship between an identity and an OIDC issuer.'
                        : 'Try a different search.'
                  }
                  action={
                    trusts.length === 0 && identities.length > 0 ? (
                      <Button onClick={openCreateTrust}>New OIDC trust</Button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Identity</TH>
                    <TH>Issuer</TH>
                    <TH>Audience</TH>
                    <TH>Sub claim pattern</TH>
                    <TH>Scope</TH>
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {filteredTrusts.map((t) => {
                    const loose = !t.is_branch_scoped || (t.sub_claim_pattern ?? '').includes('*')
                    return (
                      <TR key={t.id}>
                        <TD className="font-medium text-slate-200">
                          {identityName.get(t.identity_id) ?? t.identity_id}
                        </TD>
                        <TD className="font-mono text-xs text-slate-400">{t.issuer}</TD>
                        <TD className="font-mono text-xs text-slate-400">{t.audience ?? '-'}</TD>
                        <TD className="font-mono text-xs text-slate-400">{t.sub_claim_pattern ?? '-'}</TD>
                        <TD>
                          {t.is_branch_scoped ? (
                            <Badge tone="success">branch-scoped</Badge>
                          ) : (
                            <Badge tone="high">unscoped</Badge>
                          )}
                          {loose && (t.sub_claim_pattern ?? '').includes('*') && (
                            <Badge tone="medium" className="ml-2">
                              wildcard
                            </Badge>
                          )}
                        </TD>
                        <TD className="text-right">
                          <div className="inline-flex gap-2">
                            <Button size="sm" variant="secondary" onClick={() => openEditTrust(t)}>
                              Edit
                            </Button>
                            <Button size="sm" variant="danger" onClick={() => removeTrust(t)}>
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
      )}

      {/* Identity modal */}
      <Modal
        open={idModal}
        onClose={() => setIdModal(false)}
        title={editIdentity ? 'Edit identity' : 'New identity'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setIdModal(false)}>
              Cancel
            </Button>
            <Button onClick={saveIdentity} disabled={saving || !idForm.name.trim()}>
              {saving ? <Spinner /> : editIdentity ? 'Save' : 'Create'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Name</label>
            <input
              value={idForm.name}
              onChange={(e) => setIdForm({ ...idForm, name: e.target.value })}
              placeholder="ci-deployer"
              className={fieldClass()}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">Type</label>
              <select
                value={idForm.identity_type}
                onChange={(e) => setIdForm({ ...idForm, identity_type: e.target.value })}
                className={fieldClass()}
              >
                <option value="workload">workload</option>
                <option value="service_account">service_account</option>
                <option value="user">user</option>
                <option value="bot">bot</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">Credential kind</label>
              <select
                value={idForm.credential_kind}
                onChange={(e) => setIdForm({ ...idForm, credential_kind: e.target.value })}
                className={fieldClass()}
              >
                <option value="oidc">oidc</option>
                <option value="pat">pat</option>
                <option value="access_key">access_key</option>
                <option value="ssh_key">ssh_key</option>
              </select>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Environment</label>
            <input
              value={idForm.environment}
              onChange={(e) => setIdForm({ ...idForm, environment: e.target.value })}
              placeholder="production"
              className={fieldClass()}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={idForm.is_long_lived}
              onChange={(e) => setIdForm({ ...idForm, is_long_lived: e.target.checked })}
              className="accent-red-600"
            />
            Long-lived (static) credential
          </label>
        </div>
      </Modal>

      {/* Trust modal */}
      <Modal
        open={trustModal}
        onClose={() => setTrustModal(false)}
        title={editTrust ? 'Edit OIDC trust' : 'New OIDC trust'}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setTrustModal(false)}>
              Cancel
            </Button>
            <Button
              onClick={saveTrust}
              disabled={saving || !trustForm.identity_id || !trustForm.issuer.trim()}
            >
              {saving ? <Spinner /> : editTrust ? 'Save' : 'Create'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Identity</label>
            <select
              value={trustForm.identity_id}
              onChange={(e) => setTrustForm({ ...trustForm, identity_id: e.target.value })}
              className={fieldClass()}
            >
              <option value="">Select identity...</option>
              {identities.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Issuer</label>
            <input
              value={trustForm.issuer}
              onChange={(e) => setTrustForm({ ...trustForm, issuer: e.target.value })}
              className={fieldClass()}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Audience</label>
            <input
              value={trustForm.audience}
              onChange={(e) => setTrustForm({ ...trustForm, audience: e.target.value })}
              className={fieldClass()}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Sub claim pattern</label>
            <input
              value={trustForm.sub_claim_pattern}
              onChange={(e) => setTrustForm({ ...trustForm, sub_claim_pattern: e.target.value })}
              className={`${fieldClass()} font-mono`}
            />
            <p className="mt-1 text-xs text-slate-600">
              Tighten this to a specific repo and ref to avoid a wildcard trust.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={trustForm.is_branch_scoped}
              onChange={(e) => setTrustForm({ ...trustForm, is_branch_scoped: e.target.checked })}
              className="accent-red-600"
            />
            Branch-scoped
          </label>
        </div>
      </Modal>
    </div>
  )
}
