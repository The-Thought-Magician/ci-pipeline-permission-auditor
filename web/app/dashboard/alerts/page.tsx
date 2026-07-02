'use client'

import { useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Badge, severityTone } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Stat } from '@/components/ui/Stat'
import { Modal } from '@/components/ui/Modal'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'

interface Alert {
  id: string
  name: string
  trigger_type?: string
  threshold?: unknown
  is_enabled?: boolean
  created_at?: string
}

interface Notification {
  id: string
  title: string
  body?: string
  severity?: string
  is_read?: boolean
  link?: string | null
  created_at?: string
}

const TRIGGER_TYPES = [
  'new_critical_finding',
  'risk_score_above',
  'drift_detected',
  'secret_unrotated',
  'policy_violation',
  'crown_jewel_reachable',
]

const blankAlert = {
  name: '',
  trigger_type: 'new_critical_finding',
  threshold_value: '',
  is_enabled: true,
}

function fieldClass() {
  return 'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:border-red-500 focus:outline-none'
}

function fmtDate(s?: string) {
  if (!s) return '-'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString()
}

function triggerLabel(t?: string) {
  return (t ?? '').replace(/_/g, ' ')
}

function thresholdText(threshold: unknown): string {
  if (threshold == null) return ''
  if (typeof threshold === 'object') {
    const obj = threshold as Record<string, unknown>
    if ('value' in obj && obj.value != null) return String(obj.value)
    const entries = Object.entries(obj)
    if (entries.length === 0) return ''
    return entries.map(([k, v]) => `${k}=${String(v)}`).join(', ')
  }
  return String(threshold)
}

export default function AlertsPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'rules' | 'feed'>('rules')
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedFilter, setFeedFilter] = useState<'all' | 'unread'>('all')

  const [alertModal, setAlertModal] = useState(false)
  const [editAlert, setEditAlert] = useState<Alert | null>(null)
  const [form, setForm] = useState({ ...blankAlert })

  async function load(wsId: string) {
    setError(null)
    const [a, n] = await Promise.all([api.listAlerts(wsId), api.listNotifications(wsId)])
    setAlerts(Array.isArray(a) ? a : [])
    setNotifications(Array.isArray(n) ? n : [])
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

  function buildThreshold() {
    const v = form.threshold_value.trim()
    if (!v) return {}
    const num = Number(v)
    return { value: Number.isNaN(num) ? v : num }
  }

  function openCreate() {
    setEditAlert(null)
    setForm({ ...blankAlert })
    setAlertModal(true)
  }
  function openEdit(a: Alert) {
    setEditAlert(a)
    setForm({
      name: a.name ?? '',
      trigger_type: a.trigger_type ?? 'new_critical_finding',
      threshold_value: thresholdText(a.threshold),
      is_enabled: a.is_enabled !== false,
    })
    setAlertModal(true)
  }

  async function saveAlert() {
    if (!workspaceId) return
    setSaving(true)
    setError(null)
    try {
      const payload = {
        name: form.name.trim(),
        trigger_type: form.trigger_type,
        threshold: buildThreshold(),
        is_enabled: form.is_enabled,
      }
      if (editAlert) {
        await api.updateAlert(editAlert.id, payload)
      } else {
        await api.createAlert({ workspace_id: workspaceId, ...payload })
      }
      await load(workspaceId)
      setAlertModal(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function toggleAlert(a: Alert) {
    if (!workspaceId) return
    setError(null)
    try {
      await api.updateAlert(a.id, { is_enabled: !(a.is_enabled !== false) })
      await load(workspaceId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed')
    }
  }

  async function removeAlert(a: Alert) {
    if (!workspaceId) return
    if (!confirm(`Delete alert rule "${a.name}"?`)) return
    setError(null)
    try {
      await api.deleteAlert(a.id)
      await load(workspaceId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  async function readOne(n: Notification) {
    if (!workspaceId || n.is_read) return
    setError(null)
    try {
      await api.markNotificationRead(n.id)
      await load(workspaceId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed')
    }
  }

  async function readAll() {
    if (!workspaceId) return
    setBusy(true)
    setError(null)
    try {
      await api.markAllNotificationsRead({ workspace_id: workspaceId })
      await load(workspaceId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setBusy(false)
    }
  }

  const unreadCount = notifications.filter((n) => !n.is_read).length
  const enabledCount = alerts.filter((a) => a.is_enabled !== false).length

  const visibleNotifications = useMemo(() => {
    if (feedFilter === 'unread') return notifications.filter((n) => !n.is_read)
    return notifications
  }, [notifications, feedFilter])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner label="Loading alerts..." />
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
          <h1 className="text-xl font-bold text-slate-100">Alerts &amp; Notifications</h1>
          <p className="mt-1 text-sm text-slate-500">
            Define alert rules on your CI/CD security posture and review the notifications they raise.
          </p>
        </div>
        {tab === 'rules' ? (
          <Button onClick={openCreate}>New alert rule</Button>
        ) : (
          <Button variant="secondary" onClick={readAll} disabled={busy || unreadCount === 0}>
            {busy ? <Spinner /> : `Mark all read`}
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Alert rules" value={alerts.length} />
        <Stat label="Enabled" value={enabledCount} accent={enabledCount > 0 ? 'emerald' : 'default'} />
        <Stat label="Notifications" value={notifications.length} accent="sky" />
        <Stat
          label="Unread"
          value={unreadCount}
          accent={unreadCount > 0 ? 'red' : 'emerald'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-slate-800 bg-slate-900/60 p-1">
          <button
            onClick={() => setTab('rules')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${
              tab === 'rules' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Alert Rules ({alerts.length})
          </button>
          <button
            onClick={() => setTab('feed')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${
              tab === 'feed' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Feed ({notifications.length}
            {unreadCount > 0 ? ` · ${unreadCount} new` : ''})
          </button>
        </div>
        {tab === 'feed' && (
          <div className="ml-auto inline-flex rounded-lg border border-slate-800 bg-slate-900/60 p-1">
            <button
              onClick={() => setFeedFilter('all')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                feedFilter === 'all' ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              All
            </button>
            <button
              onClick={() => setFeedFilter('unread')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                feedFilter === 'unread' ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Unread
            </button>
          </div>
        )}
      </div>

      {tab === 'rules' ? (
        <Card>
          <CardBody className="p-0">
            {alerts.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title="No alert rules yet"
                  description="Create a rule to be notified when your posture crosses a threshold."
                  action={<Button onClick={openCreate}>New alert rule</Button>}
                />
              </div>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Trigger</TH>
                    <TH>Threshold</TH>
                    <TH>Status</TH>
                    <TH>Created</TH>
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {alerts.map((a) => (
                    <TR key={a.id}>
                      <TD className="font-medium text-slate-200">{a.name}</TD>
                      <TD>
                        <Badge tone="info">{triggerLabel(a.trigger_type)}</Badge>
                      </TD>
                      <TD className="font-mono text-xs text-slate-400">
                        {thresholdText(a.threshold) || '-'}
                      </TD>
                      <TD>
                        {a.is_enabled !== false ? (
                          <Badge tone="success">enabled</Badge>
                        ) : (
                          <Badge tone="neutral">disabled</Badge>
                        )}
                      </TD>
                      <TD className="text-xs text-slate-500">{fmtDate(a.created_at)}</TD>
                      <TD className="text-right">
                        <div className="inline-flex gap-2">
                          <Button size="sm" variant="ghost" onClick={() => toggleAlert(a)}>
                            {a.is_enabled !== false ? 'Disable' : 'Enable'}
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => openEdit(a)}>
                            Edit
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => removeAlert(a)}>
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
      ) : (
        <Card>
          <CardBody className="p-0">
            {visibleNotifications.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title={notifications.length === 0 ? 'No notifications yet' : 'Nothing unread'}
                  description={
                    notifications.length === 0
                      ? 'Notifications from your alert rules will appear here.'
                      : 'You are all caught up.'
                  }
                />
              </div>
            ) : (
              <ul className="divide-y divide-slate-800">
                {visibleNotifications.map((n) => (
                  <li
                    key={n.id}
                    className={`flex items-start gap-4 px-5 py-4 ${n.is_read ? '' : 'bg-slate-900/40'}`}
                  >
                    <span
                      className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${
                        n.is_read ? 'bg-slate-700' : 'bg-red-500'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-slate-200">{n.title}</span>
                        {n.severity && (
                          <Badge tone={severityTone(n.severity)}>{n.severity}</Badge>
                        )}
                        {!n.is_read && <Badge tone="critical">new</Badge>}
                      </div>
                      {n.body && <p className="mt-1 text-sm text-slate-400">{n.body}</p>}
                      <div className="mt-1 flex items-center gap-3 text-xs text-slate-600">
                        <span>{fmtDate(n.created_at)}</span>
                        {n.link && (
                          <a href={n.link} className="text-red-400 hover:text-red-300">
                            View
                          </a>
                        )}
                      </div>
                    </div>
                    {!n.is_read && (
                      <Button size="sm" variant="ghost" onClick={() => readOne(n)}>
                        Mark read
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      <Modal
        open={alertModal}
        onClose={() => setAlertModal(false)}
        title={editAlert ? 'Edit alert rule' : 'New alert rule'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAlertModal(false)}>
              Cancel
            </Button>
            <Button onClick={saveAlert} disabled={saving || !form.name.trim()}>
              {saving ? <Spinner /> : editAlert ? 'Save' : 'Create'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Critical finding in production"
              className={fieldClass()}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Trigger type</label>
            <select
              value={form.trigger_type}
              onChange={(e) => setForm({ ...form, trigger_type: e.target.value })}
              className={fieldClass()}
            >
              {TRIGGER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {triggerLabel(t)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">
              Threshold (optional)
            </label>
            <input
              value={form.threshold_value}
              onChange={(e) => setForm({ ...form, threshold_value: e.target.value })}
              placeholder="e.g. 70 for risk score, or a severity"
              className={fieldClass()}
            />
            <p className="mt-1 text-xs text-slate-600">
              For numeric triggers (risk score) enter a number; leave blank for event triggers.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={form.is_enabled}
              onChange={(e) => setForm({ ...form, is_enabled: e.target.checked })}
              className="accent-red-600"
            />
            Enabled
          </label>
        </div>
      </Modal>
    </div>
  )
}
