'use client'

import { useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/Badge'
import { Stat } from '@/components/ui/Stat'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'

interface Workspace {
  id: string
  name: string
}

interface BlastRadius {
  id: string
  workspace_id: string
  pipeline_id: string
  score: number
  reachable_resource_ids: string[] | null
  reachable_secret_ids: string[] | null
  reachable_pipeline_ids: string[] | null
  crown_jewel_count: number
  summary: string | null
  computed_at: string | null
  created_at: string
}

interface GraphNode {
  id: string
  label?: string
  kind?: string
}

interface AttackEdge {
  id?: string
  pipeline_id?: string
  from_node: string
  from_kind: string
  to_node: string
  to_kind: string
  edge_type: string
  weight: number
}

interface AttackGraph {
  nodes: GraphNode[]
  edges: AttackEdge[]
}

function scoreTone(score: number): 'critical' | 'high' | 'medium' | 'low' {
  if (score >= 75) return 'critical'
  if (score >= 50) return 'high'
  if (score >= 25) return 'medium'
  return 'low'
}

function scoreColor(score: number): string {
  if (score >= 75) return '#ef4444'
  if (score >= 50) return '#f97316'
  if (score >= 25) return '#f59e0b'
  return '#38bdf8'
}

const KIND_COLORS: Record<string, string> = {
  pipeline: '#ef4444',
  identity: '#f97316',
  role: '#a78bfa',
  resource: '#38bdf8',
  secret: '#f59e0b',
  action: '#34d399',
  default: '#a1a1aa',
}

function kindColor(kind?: string) {
  return KIND_COLORS[(kind ?? '').toLowerCase()] ?? KIND_COLORS.default
}

export default function BlastRadiusPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [rows, setRows] = useState<BlastRadius[]>([])
  const [graph, setGraph] = useState<AttackGraph>({ nodes: [], edges: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  async function loadAll(wsId: string, pipelineId?: string) {
    const [br, g] = await Promise.all([
      api.listBlastRadius(wsId),
      api.getAttackPaths(wsId, pipelineId),
    ])
    const sorted: BlastRadius[] = [...(br as BlastRadius[])].sort((a, b) => b.score - a.score)
    setRows(sorted)
    setGraph({ nodes: (g as AttackGraph).nodes ?? [], edges: (g as AttackGraph).edges ?? [] })
    return sorted
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const workspaces: Workspace[] = await api.listWorkspaces()
        if (cancelled) return
        if (!workspaces.length) {
          setWorkspaceId(null)
          setLoading(false)
          return
        }
        const wsId = workspaces[0].id
        setWorkspaceId(wsId)
        const sorted = await loadAll(wsId)
        if (!cancelled && sorted.length) setSelected(sorted[0].pipeline_id)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load blast radius')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const stats = useMemo(() => {
    const total = rows.length
    const max = rows.reduce((m, r) => Math.max(m, r.score), 0)
    const avg = total ? rows.reduce((s, r) => s + r.score, 0) / total : 0
    const crownExposed = rows.filter((r) => r.crown_jewel_count > 0).length
    return { total, max, avg, crownExposed }
  }, [rows])

  const selectedRow = useMemo(
    () => rows.find((r) => r.pipeline_id === selected) ?? null,
    [rows, selected],
  )

  // Edges relevant to the selected pipeline (fall back to all edges).
  const visibleEdges = useMemo(() => {
    if (!selected) return graph.edges
    const scoped = graph.edges.filter((e) => !e.pipeline_id || e.pipeline_id === selected)
    return scoped.length ? scoped : graph.edges
  }, [graph.edges, selected])

  function flash(msg: string) {
    setBanner(msg)
    setTimeout(() => setBanner(null), 4000)
  }

  async function recompute() {
    if (!workspaceId) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.computeBlastRadius({ workspace_id: workspaceId })
      const sorted = await loadAll(workspaceId, selected ?? undefined)
      if (!selected && sorted.length) setSelected(sorted[0].pipeline_id)
      flash(`Recomputed blast radius for ${res?.computed ?? sorted.length} pipeline(s).`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Compute failed')
    } finally {
      setBusy(false)
    }
  }

  async function rebuildGraph() {
    if (!workspaceId) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.rebuildAttackPaths({
        workspace_id: workspaceId,
        ...(selected ? { pipeline_id: selected } : {}),
      })
      await loadAll(workspaceId, selected ?? undefined)
      flash(`Rebuilt attack-path graph — ${res?.edges ?? 0} edge(s).`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rebuild failed')
    } finally {
      setBusy(false)
    }
  }

  // Lay out the attack-path graph nodes used by the visible edges, on a circle.
  const layout = useMemo(() => {
    const ids = new Set<string>()
    for (const e of visibleEdges) {
      ids.add(e.from_node)
      ids.add(e.to_node)
    }
    const kindOf: Record<string, string> = {}
    for (const e of visibleEdges) {
      kindOf[e.from_node] = e.from_kind
      kindOf[e.to_node] = e.to_kind
    }
    const labelOf: Record<string, string> = {}
    for (const n of graph.nodes) labelOf[n.id] = n.label ?? n.id
    const list = Array.from(ids)
    const W = 760
    const H = 420
    const cx = W / 2
    const cy = H / 2
    const r = Math.min(W, H) / 2 - 60
    const pos: Record<string, { x: number; y: number }> = {}
    list.forEach((id, i) => {
      if (list.length === 1) {
        pos[id] = { x: cx, y: cy }
      } else {
        const angle = (2 * Math.PI * i) / list.length - Math.PI / 2
        pos[id] = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }
      }
    })
    return { pos, kindOf, labelOf, W, H, count: list.length }
  }, [visibleEdges, graph.nodes])

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner label="Loading blast-radius explorer..." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-100">Blast Radius</h1>
          <p className="mt-1 text-sm text-zinc-500">
            What an attacker reaches if a pipeline is poisoned — ranked impact plus the attack-path graph.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={rebuildGraph} disabled={busy || !workspaceId}>
            Rebuild graph
          </Button>
          <Button variant="primary" onClick={recompute} disabled={busy || !workspaceId}>
            {busy ? <Spinner /> : 'Recompute'}
          </Button>
        </div>
      </div>

      {banner && (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
          {banner}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {!workspaceId ? (
        <EmptyState
          title="No workspace found"
          description="Seed sample data from the dashboard to compute blast radius."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No blast-radius results"
          description="Compute blast radius across the workspace to rank pipelines by impact."
          action={
            <Button variant="primary" onClick={recompute} disabled={busy}>
              Recompute now
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Pipelines scored" value={stats.total} />
            <Stat label="Max score" value={Math.round(stats.max)} accent="red" />
            <Stat label="Avg score" value={Math.round(stats.avg)} accent="amber" />
            <Stat label="Crown-jewel exposed" value={stats.crownExposed} accent="red" />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Ranked list */}
            <Card className="lg:col-span-1">
              <CardHeader>
                <CardTitle>Ranked pipelines</CardTitle>
              </CardHeader>
              <CardBody className="space-y-2">
                {rows.map((r) => {
                  const active = r.pipeline_id === selected
                  return (
                    <button
                      key={r.id}
                      onClick={() => setSelected(r.pipeline_id)}
                      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        active
                          ? 'border-red-700/60 bg-red-950/20'
                          : 'border-zinc-800 bg-zinc-950/50 hover:border-zinc-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-mono text-xs text-zinc-300">
                          {r.pipeline_id.slice(0, 8)}
                        </span>
                        <Badge tone={scoreTone(r.score)}>{Math.round(r.score)}</Badge>
                      </div>
                      {/* score bar */}
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, r.score)}%`,
                            background: scoreColor(r.score),
                          }}
                        />
                      </div>
                      <div className="mt-1.5 flex gap-3 text-[11px] text-zinc-500">
                        <span>{r.reachable_resource_ids?.length ?? 0} res</span>
                        <span>{r.reachable_secret_ids?.length ?? 0} sec</span>
                        <span>{r.reachable_pipeline_ids?.length ?? 0} pipe</span>
                        {r.crown_jewel_count > 0 && (
                          <span className="text-red-400">{r.crown_jewel_count} crown</span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </CardBody>
            </Card>

            {/* Detail + graph */}
            <div className="space-y-6 lg:col-span-2">
              {selectedRow && (
                <Card>
                  <CardHeader className="flex items-center justify-between">
                    <CardTitle>Reachability</CardTitle>
                    <Badge tone={scoreTone(selectedRow.score)}>
                      score {Math.round(selectedRow.score)}
                    </Badge>
                  </CardHeader>
                  <CardBody className="space-y-4">
                    {selectedRow.summary && (
                      <p className="text-sm text-zinc-400">{selectedRow.summary}</p>
                    )}
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Stat label="Resources" value={selectedRow.reachable_resource_ids?.length ?? 0} />
                      <Stat label="Secrets" value={selectedRow.reachable_secret_ids?.length ?? 0} accent="amber" />
                      <Stat label="Pipelines" value={selectedRow.reachable_pipeline_ids?.length ?? 0} />
                      <Stat label="Crown jewels" value={selectedRow.crown_jewel_count} accent="red" />
                    </div>
                  </CardBody>
                </Card>
              )}

              <Card>
                <CardHeader className="flex items-center justify-between">
                  <CardTitle>Attack-path graph</CardTitle>
                  <span className="text-xs text-zinc-500">{visibleEdges.length} edge(s)</span>
                </CardHeader>
                <CardBody>
                  {visibleEdges.length === 0 ? (
                    <div className="py-8 text-center text-sm text-zinc-500">
                      No attack-path edges. Use <span className="text-zinc-300">Rebuild graph</span> to derive them.
                    </div>
                  ) : (
                    <>
                      <div className="w-full overflow-x-auto">
                        <svg
                          viewBox={`0 0 ${layout.W} ${layout.H}`}
                          className="h-auto w-full min-w-[640px]"
                          role="img"
                          aria-label="Attack-path graph"
                        >
                          <defs>
                            <marker
                              id="arrow"
                              viewBox="0 0 10 10"
                              refX="9"
                              refY="5"
                              markerWidth="6"
                              markerHeight="6"
                              orient="auto-start-reverse"
                            >
                              <path d="M 0 0 L 10 5 L 0 10 z" fill="#71717a" />
                            </marker>
                          </defs>
                          {/* edges */}
                          {visibleEdges.map((e, i) => {
                            const a = layout.pos[e.from_node]
                            const b = layout.pos[e.to_node]
                            if (!a || !b) return null
                            const mx = (a.x + b.x) / 2
                            const my = (a.y + b.y) / 2
                            return (
                              <g key={`e-${i}`}>
                                <line
                                  x1={a.x}
                                  y1={a.y}
                                  x2={b.x}
                                  y2={b.y}
                                  stroke="#52525b"
                                  strokeWidth={Math.max(1, Math.min(4, e.weight || 1))}
                                  markerEnd="url(#arrow)"
                                  opacity={0.7}
                                />
                                <text x={mx} y={my - 3} fill="#a1a1aa" fontSize="9" textAnchor="middle">
                                  {e.edge_type}
                                </text>
                              </g>
                            )
                          })}
                          {/* nodes */}
                          {Object.entries(layout.pos).map(([id, p]) => {
                            const kind = layout.kindOf[id]
                            const label = layout.labelOf[id] ?? id
                            return (
                              <g key={`n-${id}`}>
                                <circle cx={p.x} cy={p.y} r={11} fill={kindColor(kind)} stroke="#18181b" strokeWidth={2} />
                                <text
                                  x={p.x}
                                  y={p.y + 26}
                                  fill="#d4d4d8"
                                  fontSize="10"
                                  textAnchor="middle"
                                >
                                  {label.length > 16 ? `${label.slice(0, 16)}…` : label}
                                </text>
                              </g>
                            )
                          })}
                        </svg>
                      </div>
                      {/* legend */}
                      <div className="mt-3 flex flex-wrap gap-3 text-xs text-zinc-400">
                        {Object.entries(KIND_COLORS)
                          .filter(([k]) => k !== 'default')
                          .map(([k, c]) => (
                            <span key={k} className="inline-flex items-center gap-1.5">
                              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} />
                              {k}
                            </span>
                          ))}
                      </div>
                    </>
                  )}
                </CardBody>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
