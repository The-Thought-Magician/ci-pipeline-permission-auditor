'use client'

import { useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Stat } from '@/components/ui/Stat'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'

interface Pipeline {
  id: string
  name: string
  repo?: string
  branch?: string
}

interface SourceChainLink {
  kind?: string
  label?: string
  detail?: string
  [k: string]: unknown
}

interface EffectivePermission {
  id: string
  pipeline_id: string
  action: string
  category?: string
  resource_id?: string | null
  source_chain?: SourceChainLink[] | unknown
  is_excess?: boolean
  resolved_at?: string | null
}

function chainToLinks(chain: unknown): SourceChainLink[] {
  if (Array.isArray(chain)) return chain as SourceChainLink[]
  if (chain && typeof chain === 'object') return Object.values(chain as Record<string, SourceChainLink>)
  return []
}

function linkLabel(link: SourceChainLink, i: number): string {
  if (typeof link === 'string') return link
  return (
    (link.label as string) ||
    (link.detail as string) ||
    (link.kind as string) ||
    `step ${i + 1}`
  )
}

export default function EffectivePermissionsPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [perms, setPerms] = useState<EffectivePermission[]>([])
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // Filters
  const [pipelineFilter, setPipelineFilter] = useState<string>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [excessOnly, setExcessOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  async function load(wsId: string) {
    setError(null)
    try {
      const [eff, pls] = await Promise.all([api.listEffective(wsId), api.listPipelines(wsId)])
      setPerms(Array.isArray(eff) ? eff : [])
      setPipelines(Array.isArray(pls) ? pls : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load effective permissions')
    }
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
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load workspace')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function resolve() {
    if (!workspaceId) return
    setResolving(true)
    setError(null)
    setNotice(null)
    try {
      const body: Record<string, unknown> = { workspace_id: workspaceId }
      if (pipelineFilter !== 'all') body.pipeline_id = pipelineFilter
      const res = await api.resolveEffective(body)
      setNotice(
        `Resolved ${res?.resolved ?? 0} permission(s) across ${res?.pipelines ?? 0} pipeline(s).`,
      )
      await load(workspaceId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Resolve failed')
    } finally {
      setResolving(false)
    }
  }

  const pipelineName = useMemo(() => {
    const m = new Map<string, string>()
    pipelines.forEach((p) => m.set(p.id, p.name || p.repo || p.id))
    return m
  }, [pipelines])

  const categories = useMemo(() => {
    const s = new Set<string>()
    perms.forEach((p) => p.category && s.add(p.category))
    return Array.from(s).sort()
  }, [perms])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return perms.filter((p) => {
      if (pipelineFilter !== 'all' && p.pipeline_id !== pipelineFilter) return false
      if (categoryFilter !== 'all' && p.category !== categoryFilter) return false
      if (excessOnly && !p.is_excess) return false
      if (q) {
        const hay = `${p.action} ${p.category ?? ''} ${pipelineName.get(p.pipeline_id) ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [perms, pipelineFilter, categoryFilter, excessOnly, search, pipelineName])

  const excessCount = useMemo(() => perms.filter((p) => p.is_excess).length, [perms])
  const excessPct = perms.length ? Math.round((excessCount / perms.length) * 100) : 0

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner label="Loading effective permissions..." />
      </div>
    )
  }

  if (!workspaceId) {
    return (
      <div className="mx-auto max-w-3xl py-12">
        <EmptyState
          title="No workspace found"
          description="Create a workspace and seed sample data from the dashboard to explore effective permissions."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100">Effective Permissions</h1>
          <p className="mt-1 text-sm text-slate-500">
            Resolved permissions per pipeline with full source chains and excess-privilege flags.
          </p>
        </div>
        <Button onClick={resolve} disabled={resolving}>
          {resolving ? <Spinner /> : 'Resolve permissions'}
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

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Effective perms" value={perms.length} />
        <Stat label="Excess perms" value={excessCount} accent={excessCount > 0 ? 'red' : 'emerald'} />
        <Stat label="Excess ratio" value={`${excessPct}%`} accent={excessPct > 25 ? 'red' : 'amber'} />
        <Stat label="Pipelines" value={pipelines.length} accent="sky" />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="mr-auto">Explorer</CardTitle>
            <select
              value={pipelineFilter}
              onChange={(e) => setPipelineFilter(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 focus:border-red-500 focus:outline-none"
            >
              <option value="all">All pipelines</option>
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.repo || p.id}
                </option>
              ))}
            </select>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 focus:border-red-500 focus:outline-none"
            >
              <option value="all">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={excessOnly}
                onChange={(e) => setExcessOnly(e.target.checked)}
                className="accent-red-600"
              />
              Excess only
            </label>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search action / category..."
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:border-red-500 focus:outline-none"
            />
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {filtered.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title={perms.length === 0 ? 'No effective permissions yet' : 'No matches'}
                description={
                  perms.length === 0
                    ? 'Run the resolver to compute effective permissions and their source chains.'
                    : 'Adjust filters or search to see results.'
                }
                action={
                  perms.length === 0 ? (
                    <Button onClick={resolve} disabled={resolving}>
                      {resolving ? <Spinner /> : 'Resolve now'}
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Pipeline</TH>
                  <TH>Action</TH>
                  <TH>Category</TH>
                  <TH>Source chain</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {filtered.map((p) => {
                  const links = chainToLinks(p.source_chain)
                  const isOpen = !!expanded[p.id]
                  return (
                    <TR key={p.id}>
                      <TD className="font-medium text-slate-200">
                        {pipelineName.get(p.pipeline_id) ?? p.pipeline_id}
                      </TD>
                      <TD className="font-mono text-xs text-slate-300">{p.action}</TD>
                      <TD>{p.category ? <Badge tone="info">{p.category}</Badge> : '-'}</TD>
                      <TD>
                        {links.length === 0 ? (
                          <span className="text-xs text-slate-600">no chain</span>
                        ) : (
                          <div>
                            <button
                              onClick={() => setExpanded((s) => ({ ...s, [p.id]: !isOpen }))}
                              className="text-xs text-sky-400 hover:text-sky-300"
                            >
                              {links.length} step{links.length === 1 ? '' : 's'} {isOpen ? '▲' : '▼'}
                            </button>
                            {isOpen && (
                              <ol className="mt-2 space-y-1">
                                {links.map((l, i) => (
                                  <li key={i} className="flex items-center gap-2 text-xs text-slate-400">
                                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-slate-800 text-[10px] text-slate-500">
                                      {i + 1}
                                    </span>
                                    {typeof l !== 'string' && l.kind && (
                                      <Badge tone="neutral">{String(l.kind)}</Badge>
                                    )}
                                    <span>{linkLabel(l, i)}</span>
                                  </li>
                                ))}
                              </ol>
                            )}
                          </div>
                        )}
                      </TD>
                      <TD>
                        {p.is_excess ? (
                          <Badge tone="critical">excess</Badge>
                        ) : (
                          <Badge tone="success">justified</Badge>
                        )}
                      </TD>
                    </TR>
                  )
                })}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
