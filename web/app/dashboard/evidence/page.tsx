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

interface EvidencePack {
  id: string
  workspace_id: string
  framework: string
  control: string
  title: string | null
  status: string | null
  contents: unknown
  share_token: string | null
  generated_at: string | null
  created_at: string
}

interface CoverageRow {
  control: string
  status: string
  framework?: string
}

const WS_KEY = 'cppa.workspaceId'

// Control catalogue used to drive the generate form.
const FRAMEWORKS: Record<string, { label: string; controls: { id: string; label: string }[] }> = {
  SOC2: {
    label: 'SOC 2',
    controls: [
      { id: 'CC6.1', label: 'CC6.1 — Logical access controls' },
      { id: 'CC6.2', label: 'CC6.2 — Credential provisioning' },
      { id: 'CC6.3', label: 'CC6.3 — Least privilege' },
      { id: 'CC6.6', label: 'CC6.6 — Boundary protection' },
      { id: 'CC7.1', label: 'CC7.1 — Configuration / drift monitoring' },
      { id: 'CC7.2', label: 'CC7.2 — Anomaly detection' },
      { id: 'CC8.1', label: 'CC8.1 — Change management' },
    ],
  },
  SLSA: {
    label: 'SLSA',
    controls: [
      { id: 'L1-provenance', label: 'L1 — Provenance exists' },
      { id: 'L2-hosted', label: 'L2 — Hosted build, signed provenance' },
      { id: 'L3-isolation', label: 'L3 — Hardened, isolated builds' },
      { id: 'L3-nonfalsifiable', label: 'L3 — Non-falsifiable provenance' },
    ],
  },
}

function coverageTone(status: string): 'success' | 'warning' | 'critical' | 'neutral' {
  switch ((status || '').toLowerCase()) {
    case 'covered':
    case 'pass':
    case 'compliant':
    case 'satisfied':
      return 'success'
    case 'partial':
    case 'in_progress':
      return 'warning'
    case 'gap':
    case 'fail':
    case 'missing':
    case 'uncovered':
      return 'critical'
    default:
      return 'neutral'
  }
}

function fmt(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

export default function EvidencePage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [packs, setPacks] = useState<EvidencePack[]>([])
  const [coverage, setCoverage] = useState<CoverageRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [frameworkFilter, setFrameworkFilter] = useState('all')
  const [showGenerate, setShowGenerate] = useState(false)

  const [detail, setDetail] = useState<EvidencePack | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

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
      const [p, c]: [EvidencePack[], CoverageRow[]] = await Promise.all([
        api.listEvidence(workspaceId),
        api.getControlCoverage(workspaceId),
      ])
      setPacks((p || []).slice().sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)))
      setCoverage(c || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load evidence')
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

  const flash = (msg: string) => {
    setNotice(msg)
    setTimeout(() => setNotice(null), 4000)
  }

  const filteredPacks = useMemo(
    () => packs.filter((p) => frameworkFilter === 'all' || p.framework === frameworkFilter),
    [packs, frameworkFilter],
  )

  const frameworks = useMemo(() => {
    const set = new Set<string>()
    packs.forEach((p) => set.add(p.framework))
    coverage.forEach((c) => c.framework && set.add(c.framework))
    return Array.from(set).sort()
  }, [packs, coverage])

  const coverageStats = useMemo(() => {
    const total = coverage.length
    const covered = coverage.filter((c) => coverageTone(c.status) === 'success').length
    const gaps = coverage.filter((c) => coverageTone(c.status) === 'critical').length
    const pct = total ? Math.round((covered / total) * 100) : 0
    return { total, covered, gaps, pct }
  }, [coverage])

  const generate = async (framework: string, control: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.generateEvidence({ workspace_id: workspaceId, framework, control })
      setShowGenerate(false)
      await reload()
      flash(`Generated ${framework} / ${control} evidence pack`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate evidence pack')
    } finally {
      setBusy(false)
    }
  }

  const openDetail = async (id: string) => {
    setDetail(null)
    setDetailLoading(true)
    try {
      const d: EvidencePack = await api.getEvidence(id)
      setDetail(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load pack')
    } finally {
      setDetailLoading(false)
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this evidence pack?')) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteEvidence(id)
      if (detail?.id === id) setDetail(null)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete pack')
    } finally {
      setBusy(false)
    }
  }

  const exportPack = (pack: EvidencePack) => {
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `evidence-${pack.framework}-${pack.control}.json`.replace(/[^a-z0-9.-]/gi, '_')
    a.click()
    URL.revokeObjectURL(url)
  }

  // Group coverage rows by framework for the grid.
  const coverageByFramework = useMemo(() => {
    const groups: Record<string, CoverageRow[]> = {}
    for (const row of coverage) {
      const fw = row.framework || 'Controls'
      ;(groups[fw] ||= []).push(row)
    }
    return groups
  }, [coverage])

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-zinc-100">Compliance Evidence</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Generate SOC 2 and SLSA evidence packs straight from your CI posture, and track control coverage at a
            glance.
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
          <Button onClick={() => setShowGenerate(true)} disabled={!workspaceId || busy}>
            + Generate pack
          </Button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
          {notice}
        </div>
      )}

      {!workspaceId && !loading && !error && (
        <EmptyState title="No workspace yet" description="Create or seed a workspace to generate evidence." />
      )}

      {workspaceId && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Evidence packs" value={packs.length} />
            <Stat
              label="Control coverage"
              value={`${coverageStats.pct}%`}
              accent={coverageStats.pct >= 80 ? 'emerald' : coverageStats.pct >= 50 ? 'amber' : 'red'}
              hint={`${coverageStats.covered}/${coverageStats.total} controls`}
            />
            <Stat label="Open gaps" value={coverageStats.gaps} accent={coverageStats.gaps ? 'red' : 'emerald'} />
            <Stat label="Frameworks" value={frameworks.length || Object.keys(FRAMEWORKS).length} />
          </div>

          {loading ? (
            <div className="flex justify-center py-16">
              <Spinner label="Loading evidence..." />
            </div>
          ) : (
            <>
              {/* Control coverage grid */}
              <Card>
                <CardHeader>
                  <CardTitle>Control coverage</CardTitle>
                </CardHeader>
                <CardBody>
                  {coverage.length === 0 ? (
                    <p className="text-sm text-zinc-500">
                      No coverage data yet. Generate an evidence pack to populate control status.
                    </p>
                  ) : (
                    <div className="space-y-5">
                      {Object.entries(coverageByFramework).map(([fw, rows]) => (
                        <div key={fw}>
                          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{fw}</div>
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                            {rows.map((row) => (
                              <div
                                key={`${fw}-${row.control}`}
                                className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2"
                              >
                                <span className="truncate text-sm text-zinc-200" title={row.control}>
                                  {row.control}
                                </span>
                                <Badge tone={coverageTone(row.status)}>{row.status}</Badge>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardBody>
              </Card>

              {/* Evidence packs */}
              <Card>
                <CardHeader className="flex flex-wrap items-center justify-between gap-3">
                  <CardTitle>Evidence packs</CardTitle>
                  <select
                    value={frameworkFilter}
                    onChange={(e) => setFrameworkFilter(e.target.value)}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200"
                  >
                    <option value="all">All frameworks</option>
                    {frameworks.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </CardHeader>
                <CardBody>
                  {filteredPacks.length === 0 ? (
                    <EmptyState
                      title={packs.length === 0 ? 'No evidence packs yet' : 'No packs match this framework'}
                      description={
                        packs.length === 0
                          ? 'Generate a SOC 2 or SLSA pack to bundle inventory, findings, secrets, drift, and remediation into an auditor-ready artifact.'
                          : 'Try a different framework filter.'
                      }
                      action={
                        packs.length === 0 ? (
                          <Button onClick={() => setShowGenerate(true)} disabled={busy}>
                            + Generate pack
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : (
                    <Table>
                      <THead>
                        <TR>
                          <TH>Title</TH>
                          <TH>Framework</TH>
                          <TH>Control</TH>
                          <TH>Status</TH>
                          <TH>Generated</TH>
                          <TH className="text-right">Actions</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {filteredPacks.map((p) => (
                          <TR key={p.id}>
                            <TD>
                              <button
                                className="font-medium text-zinc-100 hover:text-red-400"
                                onClick={() => openDetail(p.id)}
                              >
                                {p.title || `${p.framework} ${p.control}`}
                              </button>
                            </TD>
                            <TD>
                              <Badge tone="info">{p.framework}</Badge>
                            </TD>
                            <TD>
                              <span className="font-mono text-xs text-zinc-400">{p.control}</span>
                            </TD>
                            <TD>
                              <Badge tone={coverageTone(p.status || '')}>{p.status || 'generated'}</Badge>
                            </TD>
                            <TD>
                              <span className="text-xs text-zinc-500">{fmt(p.generated_at || p.created_at)}</span>
                            </TD>
                            <TD className="text-right">
                              <div className="flex justify-end gap-2">
                                <Button size="sm" variant="secondary" onClick={() => openDetail(p.id)}>
                                  View
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => exportPack(p)}>
                                  Export
                                </Button>
                                <Button size="sm" variant="danger" onClick={() => remove(p.id)} disabled={busy}>
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
        </>
      )}

      {showGenerate && (
        <GenerateForm onClose={() => setShowGenerate(false)} onGenerate={generate} busy={busy} />
      )}

      <Modal open={!!detail || detailLoading} onClose={() => setDetail(null)} title="Evidence pack" size="lg">
        {detailLoading ? (
          <div className="flex justify-center py-8">
            <Spinner label="Loading..." />
          </div>
        ) : detail ? (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-zinc-100">
                  {detail.title || `${detail.framework} ${detail.control}`}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <Badge tone="info">{detail.framework}</Badge>
                  <span className="font-mono text-xs text-zinc-500">{detail.control}</span>
                  <Badge tone={coverageTone(detail.status || '')}>{detail.status || 'generated'}</Badge>
                </div>
              </div>
              <Button size="sm" variant="secondary" onClick={() => exportPack(detail)}>
                Export JSON
              </Button>
            </div>
            <div className="text-xs text-zinc-500">Generated {fmt(detail.generated_at || detail.created_at)}</div>
            {detail.share_token && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs">
                <span className="text-zinc-500">Share token: </span>
                <span className="font-mono text-zinc-300">{detail.share_token}</span>
              </div>
            )}
            <div>
              <div className="mb-1 text-xs uppercase text-zinc-500">Contents</div>
              <pre className="max-h-96 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300">
                {JSON.stringify(detail.contents ?? {}, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

function GenerateForm({
  onClose,
  onGenerate,
  busy,
}: {
  onClose: () => void
  onGenerate: (framework: string, control: string) => void
  busy: boolean
}) {
  const [framework, setFramework] = useState<string>('SOC2')
  const controls = FRAMEWORKS[framework]?.controls ?? []
  const [control, setControl] = useState<string>(controls[0]?.id ?? '')

  const onFrameworkChange = (fw: string) => {
    setFramework(fw)
    setControl(FRAMEWORKS[fw]?.controls[0]?.id ?? '')
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Generate evidence pack"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onGenerate(framework, control)} disabled={busy || !control}>
            {busy ? 'Generating...' : 'Generate'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">Framework</label>
          <select
            value={framework}
            onChange={(e) => onFrameworkChange(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
          >
            {Object.entries(FRAMEWORKS).map(([id, f]) => (
              <option key={id} value={id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-zinc-500">Control</label>
          <select
            value={control}
            onChange={(e) => setControl(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
          >
            {controls.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <p className="text-xs text-zinc-500">
          The pack bundles current inventory, findings, secret hygiene, drift history, and remediation status mapped to
          the selected control.
        </p>
      </div>
    </Modal>
  )
}
