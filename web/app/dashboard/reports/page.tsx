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
import { Stat } from '@/components/ui/Stat'

interface Workspace {
  id: string
  name: string
}

interface Pipeline {
  id: string
  name: string
  repo?: string | null
}

interface Report {
  id: string
  workspace_id: string
  kind: string
  title: string
  pipeline_id?: string | null
  content?: unknown
  format?: string | null
  created_by?: string | null
  created_at?: string
}

const REPORT_KINDS = [
  { value: 'exec_summary', label: 'Executive Summary' },
  { value: 'pipeline_deep_dive', label: 'Pipeline Deep-Dive' },
  { value: 'blast_radius', label: 'Blast-Radius Report' },
  { value: 'secret_hygiene', label: 'Secret Hygiene' },
]

const FORMATS = ['json', 'markdown', 'html']

function kindLabel(kind: string): string {
  return REPORT_KINDS.find((k) => k.value === kind)?.label ?? kind
}

function kindTone(kind: string): 'critical' | 'high' | 'low' | 'info' | 'neutral' {
  switch (kind) {
    case 'exec_summary':
      return 'info'
    case 'pipeline_deep_dive':
      return 'low'
    case 'blast_radius':
      return 'critical'
    case 'secret_hygiene':
      return 'high'
    default:
      return 'neutral'
  }
}

function fmtDate(s?: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return String(s)
  return d.toLocaleString()
}

function contentToText(content: unknown, format?: string | null): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>
    // Common shapes: { markdown }, { html }, { text }, { body }
    if (typeof obj.markdown === 'string') return obj.markdown
    if (typeof obj.html === 'string') return obj.html
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.body === 'string') return obj.body
  }
  return JSON.stringify(content, null, 2)
}

export default function ReportsPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [reports, setReports] = useState<Report[]>([])
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState('all')

  const [genOpen, setGenOpen] = useState(false)
  const [form, setForm] = useState({ kind: 'exec_summary', pipeline_id: '', format: 'markdown', title: '' })

  const [viewing, setViewing] = useState<Report | null>(null)
  const [viewLoading, setViewLoading] = useState(false)

  const loadScoped = useCallback(async (wsId: string) => {
    const [reps, pls] = await Promise.all([api.listReports(wsId), api.listPipelines(wsId)])
    setReports(Array.isArray(reps) ? reps : [])
    setPipelines(Array.isArray(pls) ? pls : [])
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
      setError(e?.message ?? 'Failed to load reports')
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

  const pipelineName = useCallback(
    (id?: string | null) => (id ? pipelines.find((p) => p.id === id)?.name ?? 'Unknown pipeline' : '—'),
    [pipelines],
  )

  const openGenerate = () => {
    setForm({ kind: 'exec_summary', pipeline_id: '', format: 'markdown', title: '' })
    setGenOpen(true)
  }

  const requiresPipeline = form.kind === 'pipeline_deep_dive'

  const generate = async () => {
    if (requiresPipeline && !form.pipeline_id) {
      setError('Select a pipeline for a deep-dive report')
      return
    }
    setBusy('generate')
    setError(null)
    try {
      const body: Record<string, unknown> = {
        workspace_id: workspaceId,
        kind: form.kind,
        format: form.format,
      }
      if (form.pipeline_id) body.pipeline_id = form.pipeline_id
      if (form.title.trim()) body.title = form.title.trim()
      const created = await api.generateReport(body)
      setGenOpen(false)
      await loadScoped(workspaceId)
      if (created && created.id) await openReport(created)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to generate report')
    } finally {
      setBusy(null)
    }
  }

  const removeReport = async (r: Report) => {
    if (!confirm(`Delete report "${r.title}"?`)) return
    setBusy(`del-${r.id}`)
    setError(null)
    try {
      await api.deleteReport(r.id)
      if (viewing?.id === r.id) setViewing(null)
      await loadScoped(workspaceId)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to delete report')
    } finally {
      setBusy(null)
    }
  }

  const openReport = async (r: Report) => {
    setViewing(r)
    setViewLoading(true)
    try {
      const full = await api.getReport(r.id)
      if (full) setViewing(full)
    } catch {
      // keep row data
    } finally {
      setViewLoading(false)
    }
  }

  const downloadReport = (r: Report) => {
    const fmt = (r.format ?? 'json').toLowerCase()
    const text = contentToText(r.content, r.format)
    const ext = fmt === 'markdown' ? 'md' : fmt === 'html' ? 'html' : 'json'
    const mime = fmt === 'html' ? 'text/html' : fmt === 'json' ? 'application/json' : 'text/plain'
    const body = ext === 'json' && typeof r.content !== 'string' ? JSON.stringify(r.content ?? {}, null, 2) : text
    const blob = new Blob([body], { type: `${mime};charset=utf-8` })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const safe = (r.title || r.kind || 'report').replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()
    link.download = `${safe}.${ext}`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return reports.filter((r) => {
      if (kindFilter !== 'all' && r.kind !== kindFilter) return false
      if (!q) return true
      return (
        r.title.toLowerCase().includes(q) ||
        r.kind.toLowerCase().includes(q) ||
        kindLabel(r.kind).toLowerCase().includes(q)
      )
    })
  }, [reports, search, kindFilter])

  const stats = useMemo(() => {
    const byKind: Record<string, number> = {}
    for (const r of reports) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
    return { total: reports.length, byKind }
  }, [reports])

  const isEmpty = workspaces.length === 0

  if (loading && reports.length === 0 && !isEmpty) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner label="Loading reports..." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-100">Reports</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Generate executive summaries, pipeline deep-dives, blast-radius and secret-hygiene reports — view and export.
          </p>
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
          description="Create or seed a workspace from the dashboard before generating reports."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Total reports" value={stats.total} />
            {REPORT_KINDS.map((k) => (
              <Stat key={k.value} label={k.label} value={stats.byKind[k.value] ?? 0} />
            ))}
          </div>

          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Generated Reports</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search reports..."
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-500/60"
                />
                <select
                  value={kindFilter}
                  onChange={(e) => setKindFilter(e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-red-500/60"
                >
                  <option value="all">All kinds</option>
                  {REPORT_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="secondary" onClick={refresh} disabled={loading}>
                  Refresh
                </Button>
                <Button size="sm" onClick={openGenerate}>
                  Generate report
                </Button>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              {filtered.length === 0 ? (
                <div className="p-6">
                  <EmptyState
                    title={reports.length === 0 ? 'No reports yet' : 'No matching reports'}
                    description={
                      reports.length === 0
                        ? 'Generate an executive summary, pipeline deep-dive, blast-radius, or secret-hygiene report.'
                        : 'Adjust your search or kind filter.'
                    }
                    action={reports.length === 0 ? <Button onClick={openGenerate}>Generate report</Button> : undefined}
                  />
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Title</TH>
                      <TH>Kind</TH>
                      <TH>Pipeline</TH>
                      <TH>Format</TH>
                      <TH>Generated</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {filtered.map((r) => (
                      <TR key={r.id} className="cursor-pointer" onClick={() => openReport(r)}>
                        <TD className="font-medium text-zinc-100">{r.title}</TD>
                        <TD>
                          <Badge tone={kindTone(r.kind)}>{kindLabel(r.kind)}</Badge>
                        </TD>
                        <TD className="text-zinc-400">{r.pipeline_id ? pipelineName(r.pipeline_id) : '—'}</TD>
                        <TD>
                          <Badge tone="neutral">{(r.format ?? 'json').toUpperCase()}</Badge>
                        </TD>
                        <TD className="text-zinc-500">{fmtDate(r.created_at)}</TD>
                        <TD className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex justify-end gap-2">
                            <Button size="sm" variant="secondary" onClick={() => openReport(r)}>
                              View
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => downloadReport(r)}>
                              Export
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => removeReport(r)}
                              disabled={busy === `del-${r.id}`}
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

      {/* Generate modal */}
      <Modal
        open={genOpen}
        onClose={() => setGenOpen(false)}
        title="Generate report"
        footer={
          <>
            <Button variant="ghost" onClick={() => setGenOpen(false)}>
              Cancel
            </Button>
            <Button onClick={generate} disabled={busy === 'generate'}>
              {busy === 'generate' ? 'Generating...' : 'Generate'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Report kind">
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-500/60"
            >
              {REPORT_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Pipeline${requiresPipeline ? '' : ' (optional)'}`}>
            <select
              value={form.pipeline_id}
              onChange={(e) => setForm({ ...form, pipeline_id: e.target.value })}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-500/60"
            >
              <option value="">{requiresPipeline ? 'Select a pipeline' : 'All pipelines'}</option>
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.repo ? ` (${p.repo})` : ''}
                </option>
              ))}
            </select>
            {requiresPipeline && (
              <span className="mt-1 block text-xs text-zinc-500">A pipeline deep-dive targets a single pipeline.</span>
            )}
          </Field>
          <Field label="Format">
            <select
              value={form.format}
              onChange={(e) => setForm({ ...form, format: e.target.value })}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-500/60"
            >
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f.toUpperCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title (optional)">
            <TextInput
              value={form.title}
              onChange={(v) => setForm({ ...form, title: v })}
              placeholder="Leave blank to auto-title"
            />
          </Field>
        </div>
      </Modal>

      {/* View modal */}
      <Modal
        open={viewing != null}
        onClose={() => setViewing(null)}
        title={viewing ? viewing.title : 'Report'}
        size="lg"
        footer={
          viewing ? (
            <>
              <Button variant="ghost" onClick={() => setViewing(null)}>
                Close
              </Button>
              <Button onClick={() => downloadReport(viewing)}>Export</Button>
            </>
          ) : undefined
        }
      >
        {viewing && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={kindTone(viewing.kind)}>{kindLabel(viewing.kind)}</Badge>
              <Badge tone="neutral">{(viewing.format ?? 'json').toUpperCase()}</Badge>
              {viewing.pipeline_id && <Badge tone="info">{pipelineName(viewing.pipeline_id)}</Badge>}
              <span className="text-xs text-zinc-500">{fmtDate(viewing.created_at)}</span>
              {viewLoading && <Spinner label="Loading..." />}
            </div>
            <div className="max-h-[55vh] overflow-auto rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
              <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-300">
                {contentToText(viewing.content, viewing.format) || 'This report has no content body.'}
              </pre>
            </div>
          </div>
        )}
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
