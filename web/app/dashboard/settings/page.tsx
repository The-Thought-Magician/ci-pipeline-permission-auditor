'use client'

import { useEffect, useState } from 'react'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Stat } from '@/components/ui/Stat'
import { Modal } from '@/components/ui/Modal'

interface Workspace {
  id: string
  name: string
  slug?: string
  description?: string | null
  severity_thresholds?: Record<string, unknown> | null
  rotation_age_days?: number | null
  created_at?: string
}

interface BillingPlan {
  subscription?: {
    plan_id?: string
    status?: string
    current_period_end?: string | null
  } | null
  plan?: {
    id?: string
    name?: string
    price_cents?: number
  } | null
  stripeEnabled?: boolean
}

const SEVERITY_KEYS = ['critical', 'high', 'medium', 'low'] as const

function fieldClass() {
  return 'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:border-red-500 focus:outline-none'
}

function fmtDate(s?: string | null) {
  if (!s) return '-'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString()
}

function priceLabel(cents?: number) {
  if (cents == null) return '-'
  if (cents === 0) return 'Free'
  return `$${(cents / 100).toFixed(2)}/mo`
}

export default function SettingsPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [billing, setBilling] = useState<BillingPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const [form, setForm] = useState({
    name: '',
    description: '',
    rotation_age_days: 90,
    thresholds: { critical: 90, high: 70, medium: 40, low: 10 } as Record<string, number>,
  })

  const [createModal, setCreateModal] = useState(false)
  const [createForm, setCreateForm] = useState({ name: '', slug: '', description: '' })

  function syncForm(ws: Workspace | null) {
    if (!ws) return
    const th = (ws.severity_thresholds ?? {}) as Record<string, unknown>
    setForm({
      name: ws.name ?? '',
      description: ws.description ?? '',
      rotation_age_days: ws.rotation_age_days ?? 90,
      thresholds: {
        critical: Number(th.critical ?? 90),
        high: Number(th.high ?? 70),
        medium: Number(th.medium ?? 40),
        low: Number(th.low ?? 10),
      },
    })
  }

  async function loadAll(preferId?: string) {
    setError(null)
    const [ws, plan] = await Promise.all([api.listWorkspaces(), api.getBillingPlan()])
    const list: Workspace[] = Array.isArray(ws) ? ws : []
    setWorkspaces(list)
    setBilling(plan ?? null)
    const next = list.find((w) => w.id === preferId) ?? list[0] ?? null
    setActiveId(next?.id ?? null)
    syncForm(next)
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        await loadAll()
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const active = workspaces.find((w) => w.id === activeId) ?? null

  function selectWorkspace(id: string) {
    const ws = workspaces.find((w) => w.id === id) ?? null
    setActiveId(id)
    setNotice(null)
    syncForm(ws)
  }

  async function saveWorkspace() {
    if (!activeId) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await api.updateWorkspace(activeId, {
        name: form.name.trim(),
        description: form.description,
        rotation_age_days: Number(form.rotation_age_days),
        severity_thresholds: form.thresholds,
      })
      await loadAll(activeId)
      setNotice('Workspace settings saved.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function createWorkspace() {
    setSaving(true)
    setError(null)
    try {
      const created = await api.createWorkspace({
        name: createForm.name.trim(),
        slug: createForm.slug.trim() || undefined,
        description: createForm.description,
      })
      setCreateModal(false)
      setCreateForm({ name: '', slug: '', description: '' })
      await loadAll(created?.id)
      setNotice('Workspace created.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed')
    } finally {
      setSaving(false)
    }
  }

  async function seed() {
    setBusy('seed')
    setError(null)
    setNotice(null)
    try {
      const res = await api.seedSample()
      await loadAll(res?.workspace_id)
      setNotice('Sample workspace seeded with providers, pipelines, findings and more.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Seed failed')
    } finally {
      setBusy(null)
    }
  }

  async function resetSample() {
    if (!confirm('Delete the sample workspace and all of its child data?')) return
    setBusy('reset')
    setError(null)
    setNotice(null)
    try {
      await api.deleteSample()
      await loadAll()
      setNotice('Sample workspace removed.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed')
    } finally {
      setBusy(null)
    }
  }

  async function checkout() {
    setBusy('checkout')
    setError(null)
    try {
      const res = await api.startCheckout()
      if (res?.url) window.location.href = res.url
      else setError('Checkout is not available.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkout unavailable')
    } finally {
      setBusy(null)
    }
  }

  async function portal() {
    setBusy('portal')
    setError(null)
    try {
      const res = await api.openPortal()
      if (res?.url) window.location.href = res.url
      else setError('Billing portal is not available.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Portal unavailable')
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner label="Loading settings..." />
      </div>
    )
  }

  const planId = billing?.subscription?.plan_id ?? billing?.plan?.id ?? 'free'
  const isPro = planId === 'pro'

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100">Settings</h1>
          <p className="mt-1 text-sm text-slate-500">
            Workspace configuration, severity thresholds, billing, and sample data.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setCreateModal(true)}>
          New workspace
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
          {notice}
        </div>
      )}

      {workspaces.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-slate-500">Workspace:</span>
          {workspaces.map((w) => (
            <button
              key={w.id}
              onClick={() => selectWorkspace(w.id)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                w.id === activeId
                  ? 'border-red-700 bg-red-950/50 text-red-200'
                  : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:text-slate-100'
              }`}
            >
              {w.name}
            </button>
          ))}
        </div>
      )}

      {!active ? (
        <EmptyState
          title="No workspace yet"
          description="Create a workspace or seed sample data to get started."
          action={
            <div className="flex gap-2">
              <Button onClick={() => setCreateModal(true)}>New workspace</Button>
              <Button variant="secondary" onClick={seed} disabled={busy === 'seed'}>
                {busy === 'seed' ? <Spinner /> : 'Seed sample data'}
              </Button>
            </div>
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>Workspace</CardTitle>
              </CardHeader>
              <CardBody className="space-y-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-400">Name</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className={fieldClass()}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-400">Slug</label>
                  <input
                    value={active.slug ?? ''}
                    readOnly
                    className={`${fieldClass()} cursor-not-allowed font-mono text-slate-500`}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-400">Description</label>
                  <textarea
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    rows={2}
                    className={fieldClass()}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-400">
                    Secret rotation age (days)
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={form.rotation_age_days}
                    onChange={(e) =>
                      setForm({ ...form, rotation_age_days: Number(e.target.value) })
                    }
                    className={`${fieldClass()} max-w-[10rem]`}
                  />
                  <p className="mt-1 text-xs text-slate-600">
                    Secrets older than this are flagged as overdue for rotation.
                  </p>
                </div>
                <div className="flex justify-end">
                  <Button onClick={saveWorkspace} disabled={saving || !form.name.trim()}>
                    {saving ? <Spinner /> : 'Save changes'}
                  </Button>
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Severity thresholds</CardTitle>
              </CardHeader>
              <CardBody>
                <p className="mb-4 text-xs text-slate-500">
                  Risk-score boundaries that map a finding or pipeline to each severity band (0-100).
                </p>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {SEVERITY_KEYS.map((k) => (
                    <div key={k}>
                      <label className="mb-1 flex items-center gap-2 text-xs font-medium text-slate-400">
                        <Badge tone={k}>{k}</Badge>
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={form.thresholds[k]}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            thresholds: { ...form.thresholds, [k]: Number(e.target.value) },
                          })
                        }
                        className={fieldClass()}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex justify-end">
                  <Button onClick={saveWorkspace} disabled={saving}>
                    {saving ? <Spinner /> : 'Save thresholds'}
                  </Button>
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Sample data</CardTitle>
              </CardHeader>
              <CardBody>
                <p className="mb-4 text-sm text-slate-400">
                  Seed a fully-populated demo workspace (providers, pipelines, identities, findings,
                  policies, snapshots and more), or reset it to start clean.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={seed} disabled={busy === 'seed'}>
                    {busy === 'seed' ? <Spinner /> : 'Seed sample workspace'}
                  </Button>
                  <Button variant="danger" onClick={resetSample} disabled={busy === 'reset'}>
                    {busy === 'reset' ? <Spinner /> : 'Reset sample data'}
                  </Button>
                </div>
              </CardBody>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Plan &amp; billing</CardTitle>
              </CardHeader>
              <CardBody className="space-y-4">
                <Stat
                  label="Current plan"
                  value={
                    <span className="flex items-center gap-2">
                      {billing?.plan?.name ?? (isPro ? 'Pro' : 'Free')}
                      <Badge tone={isPro ? 'success' : 'neutral'}>{planId}</Badge>
                    </span>
                  }
                  hint={priceLabel(billing?.plan?.price_cents)}
                  accent={isPro ? 'emerald' : 'default'}
                />
                <div className="space-y-1 text-xs text-slate-500">
                  <div className="flex justify-between">
                    <span>Status</span>
                    <span className="text-slate-300">
                      {billing?.subscription?.status ?? 'active'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Renews</span>
                    <span className="text-slate-300">
                      {fmtDate(billing?.subscription?.current_period_end)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Stripe</span>
                    <span className="text-slate-300">
                      {billing?.stripeEnabled ? 'connected' : 'not configured'}
                    </span>
                  </div>
                </div>

                {!billing?.stripeEnabled ? (
                  <p className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-500">
                    Billing is not configured on this deployment. Set Stripe keys to enable
                    upgrades.
                  </p>
                ) : isPro ? (
                  <Button
                    variant="secondary"
                    className="w-full"
                    onClick={portal}
                    disabled={busy === 'portal'}
                  >
                    {busy === 'portal' ? <Spinner /> : 'Manage subscription'}
                  </Button>
                ) : (
                  <Button className="w-full" onClick={checkout} disabled={busy === 'checkout'}>
                    {busy === 'checkout' ? <Spinner /> : 'Upgrade to Pro'}
                  </Button>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardBody className="space-y-2 text-xs text-slate-500">
                <div className="flex justify-between gap-3">
                  <span>Workspace ID</span>
                  <span className="truncate font-mono text-slate-400">{active.id}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>Created</span>
                  <span className="text-slate-400">{fmtDate(active.created_at)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>Total workspaces</span>
                  <span className="text-slate-400">{workspaces.length}</span>
                </div>
              </CardBody>
            </Card>
          </div>
        </div>
      )}

      <Modal
        open={createModal}
        onClose={() => setCreateModal(false)}
        title="New workspace"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateModal(false)}>
              Cancel
            </Button>
            <Button onClick={createWorkspace} disabled={saving || !createForm.name.trim()}>
              {saving ? <Spinner /> : 'Create'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Name</label>
            <input
              value={createForm.name}
              onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              placeholder="Acme Platform"
              className={fieldClass()}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">
              Slug (optional)
            </label>
            <input
              value={createForm.slug}
              onChange={(e) => setCreateForm({ ...createForm, slug: e.target.value })}
              placeholder="acme-platform"
              className={`${fieldClass()} font-mono`}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Description</label>
            <textarea
              value={createForm.description}
              onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
              rows={2}
              className={fieldClass()}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
