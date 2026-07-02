'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import api from '@/lib/api'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { Stat } from '@/components/ui/Stat'
import { EmptyState } from '@/components/ui/EmptyState'

interface Workspace {
  id: string
  name: string
}

interface Provider {
  id: string
  name: string
  kind: string
}

interface Pipeline {
  id: string
  workspace_id: string
  provider_id?: string | null
  team_id?: string | null
  name: string
  repo?: string | null
  branch?: string | null
  file_path?: string | null
  risk_score?: number | null
  last_seen_at?: string | null
  created_at?: string
}

type RiskBand = 'all' | 'critical' | 'high' | 'medium' | 'low'

function riskBand(score: number): Exclude<RiskBand, 'all'> {
  if (score >= 70) return 'critical'
  if (score >= 50) return 'high'
  if (score >= 25) return 'medium'
  return 'low'
}

function riskTone(score: number): 'critical' | 'high' | 'medium' | 'low' {
  return riskBand(score)
}

function fmtScore(n?: number | null): string {
  const v = typeof n === 'number' ? n : 0
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

function fmtDate(s?: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleDateString()
}

export default function PipelinesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [band, setBand] = useState<RiskBand>('all')
  const [sortDesc, setSortDesc] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [createModal, setCreateModal] = useState(false)
  const [form, setForm] = useState({
    name: '',
    repo: '',
    branch: 'main',
    file_path: '.github/workflows/ci.yml',
    provider_id: '',
    raw_source: '',
  })

  const loadScoped = useCallback(async (wsId: string) => {
    const [pl, prov] = await Promise.all([api.listPipelines(wsId), api.listProviders(wsId)])
    setPipelines(Array.isArray(pl) ? pl : [])
    setProviders(Array.isArray(prov) ? prov : [])
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
      setError(e?.message ?? 'Failed to load pipelines')
    } finally {
      setLoading(false)
    }
  }, [loadScoped])

  useEffect(() => {
    init()
  }, [init])

  const onSelectWorkspace = async (id: string) => {
    setWorkspaceId(id)
    setSelected(new Set())
    setLoading(true)
    try {
      await loadScoped(id)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

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

  const providerName = useCallback(
    (id?: string | null) => (id ? providers.find((p) => p.id === id)?.name ?? '—' : '—'),
    [providers],
  )

  const createPipeline = async () => {
    if (!form.name.trim()) {
      setError('Pipeline name is required')
      return
    }
    setBusy('create')
    setError(null)
    try {
      await api.createPipeline({
        workspace_id: workspaceId,
        name: form.name.trim(),
        repo: form.repo || null,
        branch: form.branch || null,
        file_path: form.file_path || null,
        provider_id: form.provider_id || null,
        raw_source: form.raw_source || null,
      })
      setCreateModal(false)
      setForm({ name: '', repo: '', branch: 'main', file_path: '.github/workflows/ci.yml', provider_id: '', raw_source: '' })
      await loadScoped(workspaceId)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to create pipeline')
    } finally {
      setBusy(null)
    }
  }

  const analyzeOne = async (p: Pipeline) => {
    setBusy(`analyze-${p.id}`)
    setError(null)
    try {
      await api.analyzePipeline(p.id)
      await loadScoped(workspaceId)
    } catch (e: any) {
      setError(e?.message ?? 'Analysis failed')
    } finally {
      setBusy(null)
    }
  }

  const deleteOne = async (p: Pipeline) => {
    if (!confirm(`Delete pipeline "${p.name}"?`)) return
    setBusy(`del-${p.id}`)
    setError(null)
    try {
      await api.deletePipeline(p.id)
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(p.id)
        return next
      })
      await loadScoped(workspaceId)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to delete')
    } finally {
      setBusy(null)
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let rows = pipelines.filter((p) => {
      if (q) {
        const hit =
          p.name.toLowerCase().includes(q) ||
          (p.repo ?? '').toLowerCase().includes(q) ||
          (p.branch ?? '').toLowerCase().includes(q) ||
          (p.file_path ?? '').toLowerCase().includes(q)
        if (!hit) return false
      }
      if (band !== 'all' && riskBand(p.risk_score ?? 0) !== band) return false
      return true
    })
    rows = [...rows].sort((a, b) => {
      const d = (b.risk_score ?? 0) - (a.risk_score ?? 0)
      return sortDesc ? d : -d
    })
    return rows
  }, [pipelines, search, band, sortDesc])

  const allVisibleSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id))
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        filtered.forEach((p) => next.delete(p.id))
      } else {
        filtered.forEach((p) => next.add(p.id))
      }
      return next
    })
  }
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const bulkAnalyze = async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    setBusy('bulk-analyze')
    setError(null)
    try {
      for (const id of ids) {
        await api.analyzePipeline(id)
      }
      await loadScoped(workspaceId)
    } catch (e: any) {
      setError(e?.message ?? 'Bulk analyze failed')
    } finally {
      setBusy(null)
    }
  }

  const bulkDelete = async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    if (!confirm(`Delete ${ids.length} selected pipeline(s)?`)) return
    setBusy('bulk-delete')
    setError(null)
    try {
      for (const id of ids) {
        await api.deletePipeline(id)
      }
      setSelected(new Set())
      await loadScoped(workspaceId)
    } catch (e: any) {
      setError(e?.message ?? 'Bulk delete failed')
    } finally {
      setBusy(null)
    }
  }

  const stats = useMemo(() => {
    const total = pipelines.length
    const scores = pipelines.map((p) => p.risk_score ?? 0)
    const avg = total ? scores.reduce((a, b) => a + b, 0) / total : 0
    const critical = pipelines.filter((p) => (p.risk_score ?? 0) >= 70).length
    const high = pipelines.filter((p) => {
      const s = p.risk_score ?? 0
      return s >= 50 && s < 70
    }).length
    return { total, avg, critical, high }
  }, [pipelines])

  const isEmpty = workspaces.length === 0

  if (loading && pipelines.length === 0 && !isEmpty) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner label="Loading pipelines..." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100">Pipeline Inventory</h1>
          <p className="mt-1 text-sm text-slate-500">Every CI/CD pipeline, ranked by computed permission risk.</p>
        </div>
        <div className="flex items-center gap-2">
          {workspaces.length > 1 && (
            <select
              value={workspaceId}
              onChange={(e) => onSelectWorkspace(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-red-500/60"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
          <Button size="sm" variant="secondary" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
          <Button size="sm" onClick={() => setCreateModal(true)} disabled={isEmpty}>
            Add pipeline
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {isEmpty ? (
        <EmptyState
          title="No workspace"
          description="Create or seed a workspace from the dashboard before adding pipelines."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Pipelines" value={stats.total} />
            <Stat label="Avg Risk" value={fmtScore(stats.avg)} accent={stats.avg >= 70 ? 'red' : stats.avg >= 40 ? 'amber' : 'emerald'} />
            <Stat label="Critical (≥70)" value={stats.critical} accent={stats.critical > 0 ? 'red' : 'emerald'} />
            <Stat label="High (50-69)" value={stats.high} accent={stats.high > 0 ? 'amber' : 'emerald'} />
          </div>

          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Pipelines</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search repo, branch, file..."
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-red-500/60"
                />
                <select
                  value={band}
                  onChange={(e) => setBand(e.target.value as RiskBand)}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-red-500/60"
                >
                  <option value="all">All risk</option>
                  <option value="critical">Critical (≥70)</option>
                  <option value="high">High (50-69)</option>
                  <option value="medium">Medium (25-49)</option>
                  <option value="low">Low (&lt;25)</option>
                </select>
                <Button size="sm" variant="ghost" onClick={() => setSortDesc((v) => !v)}>
                  Risk {sortDesc ? '↓' : '↑'}
                </Button>
              </div>
            </CardHeader>

            {selected.size > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/60 px-5 py-3">
                <span className="text-sm text-slate-300">{selected.size} selected</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={bulkAnalyze} disabled={busy === 'bulk-analyze'}>
                    {busy === 'bulk-analyze' ? 'Analyzing...' : 'Re-analyze selected'}
                  </Button>
                  <Button size="sm" variant="danger" onClick={bulkDelete} disabled={busy === 'bulk-delete'}>
                    {busy === 'bulk-delete' ? 'Deleting...' : 'Delete selected'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                    Clear
                  </Button>
                </div>
              </div>
            )}

            <CardBody className="p-0">
              {filtered.length === 0 ? (
                <div className="p-6">
                  <EmptyState
                    title={pipelines.length === 0 ? 'No pipelines' : 'No matches'}
                    description={
                      pipelines.length === 0
                        ? 'Add a pipeline manually, or sync a provider connection to ingest them automatically.'
                        : 'No pipelines match the current search/filter.'
                    }
                    action={
                      pipelines.length === 0 ? (
                        <Button onClick={() => setCreateModal(true)}>Add pipeline</Button>
                      ) : undefined
                    }
                  />
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH className="w-10">
                        <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} aria-label="Select all" />
                      </TH>
                      <TH>Pipeline</TH>
                      <TH>Repo</TH>
                      <TH>Branch</TH>
                      <TH>Provider</TH>
                      <TH>Risk</TH>
                      <TH>Last seen</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {filtered.map((p) => {
                      const score = p.risk_score ?? 0
                      return (
                        <TR key={p.id}>
                          <TD>
                            <input
                              type="checkbox"
                              checked={selected.has(p.id)}
                              onChange={() => toggleOne(p.id)}
                              aria-label={`Select ${p.name}`}
                            />
                          </TD>
                          <TD className="font-medium text-slate-100">
                            <Link href={`/dashboard/pipelines/${p.id}`} className="hover:text-red-300">
                              {p.name}
                            </Link>
                            {p.file_path && <div className="text-xs text-slate-600">{p.file_path}</div>}
                          </TD>
                          <TD className="text-slate-400">{p.repo || '—'}</TD>
                          <TD className="text-slate-400">{p.branch || '—'}</TD>
                          <TD className="text-slate-400">{providerName(p.provider_id)}</TD>
                          <TD>
                            <div className="flex items-center gap-2">
                              <Badge tone={riskTone(score)}>{fmtScore(score)}</Badge>
                              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-800">
                                <div
                                  className={
                                    score >= 70
                                      ? 'h-full bg-red-500'
                                      : score >= 50
                                        ? 'h-full bg-orange-500'
                                        : score >= 25
                                          ? 'h-full bg-amber-500'
                                          : 'h-full bg-sky-500'
                                  }
                                  style={{ width: `${Math.min(100, score)}%` }}
                                />
                              </div>
                            </div>
                          </TD>
                          <TD className="text-slate-500">{fmtDate(p.last_seen_at)}</TD>
                          <TD className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => analyzeOne(p)}
                                disabled={busy === `analyze-${p.id}`}
                              >
                                {busy === `analyze-${p.id}` ? 'Analyzing...' : 'Analyze'}
                              </Button>
                              <Link href={`/dashboard/pipelines/${p.id}`}>
                                <Button size="sm" variant="ghost">
                                  Detail
                                </Button>
                              </Link>
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => deleteOne(p)}
                                disabled={busy === `del-${p.id}`}
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
        </>
      )}

      <Modal
        open={createModal}
        onClose={() => setCreateModal(false)}
        title="Add pipeline"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateModal(false)}>
              Cancel
            </Button>
            <Button onClick={createPipeline} disabled={busy === 'create'}>
              {busy === 'create' ? 'Creating...' : 'Create pipeline'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name">
            <TextInput value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="API CI" />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Repo">
              <TextInput value={form.repo} onChange={(v) => setForm({ ...form, repo: v })} placeholder="acme/api" />
            </Field>
            <Field label="Branch">
              <TextInput value={form.branch} onChange={(v) => setForm({ ...form, branch: v })} placeholder="main" />
            </Field>
          </div>
          <Field label="Workflow file path">
            <TextInput
              value={form.file_path}
              onChange={(v) => setForm({ ...form, file_path: v })}
              placeholder=".github/workflows/ci.yml"
            />
          </Field>
          <Field label="Provider">
            <select
              value={form.provider_id}
              onChange={(e) => setForm({ ...form, provider_id: e.target.value })}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-red-500/60"
            >
              <option value="">No provider</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.kind})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Raw workflow source (optional — parsed on create)">
            <textarea
              value={form.raw_source}
              onChange={(e) => setForm({ ...form, raw_source: e.target.value })}
              rows={6}
              placeholder={'name: CI\non: [push]\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest'}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-red-500/60"
            />
          </Field>
        </div>
      </Modal>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
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
      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-red-500/60"
    />
  )
}
