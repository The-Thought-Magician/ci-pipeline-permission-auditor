'use client'

import { useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Badge } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Stat } from '@/components/ui/Stat'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'

interface ActivityEntry {
  id: string
  actor_id?: string
  action?: string
  entity_type?: string
  entity_id?: string
  metadata?: unknown
  created_at?: string
}

function fmtDate(s?: string) {
  if (!s) return '-'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString()
}

function actionTone(action?: string): 'success' | 'critical' | 'medium' | 'info' | 'neutral' {
  const a = (action ?? '').toLowerCase()
  if (a.includes('delete') || a.includes('remove')) return 'critical'
  if (a.includes('create') || a.includes('add')) return 'success'
  if (a.includes('update') || a.includes('edit') || a.includes('apply')) return 'medium'
  if (a.includes('run') || a.includes('scan') || a.includes('evaluate') || a.includes('compute'))
    return 'info'
  return 'neutral'
}

function metaSummary(metadata: unknown): string {
  if (metadata == null) return ''
  if (typeof metadata === 'string') return metadata
  if (typeof metadata === 'object') {
    try {
      return JSON.stringify(metadata)
    } catch {
      return ''
    }
  }
  return String(metadata)
}

export default function ActivityPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [actorFilter, setActorFilter] = useState('')
  const [entityFilter, setEntityFilter] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

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
        const a = await api.listActivity(first.id)
        if (cancelled) return
        setEntries(Array.isArray(a) ? a : [])
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

  const actors = useMemo(() => {
    const s = new Set<string>()
    entries.forEach((e) => e.actor_id && s.add(e.actor_id))
    return Array.from(s).sort()
  }, [entries])

  const entityTypes = useMemo(() => {
    const s = new Set<string>()
    entries.forEach((e) => e.entity_type && s.add(e.entity_type))
    return Array.from(s).sort()
  }, [entries])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter((e) => {
      if (actorFilter && e.actor_id !== actorFilter) return false
      if (entityFilter && e.entity_type !== entityFilter) return false
      if (!q) return true
      return `${e.action ?? ''} ${e.entity_type ?? ''} ${e.entity_id ?? ''} ${e.actor_id ?? ''} ${metaSummary(e.metadata)}`
        .toLowerCase()
        .includes(q)
    })
  }, [entries, search, actorFilter, entityFilter])

  function clearFilters() {
    setSearch('')
    setActorFilter('')
    setEntityFilter('')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner label="Loading activity..." />
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
          <h1 className="text-xl font-bold text-zinc-100">Activity Log</h1>
          <p className="mt-1 text-sm text-zinc-500">
            An immutable, append-only record of every change in this workspace. Filter by actor,
            entity, or free text.
          </p>
        </div>
        <Badge tone="info">read-only / tamper-evident</Badge>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Total events" value={entries.length} />
        <Stat label="Showing" value={filtered.length} accent="sky" />
        <Stat label="Distinct actors" value={actors.length} />
        <Stat label="Entity types" value={entityTypes.length} />
      </div>

      <Card>
        <CardBody>
          <div className="flex flex-wrap items-center gap-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search action, entity, metadata..."
              className="min-w-[14rem] flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-red-500 focus:outline-none"
            />
            <select
              value={actorFilter}
              onChange={(e) => setActorFilter(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:border-red-500 focus:outline-none"
            >
              <option value="">All actors</option>
              {actors.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <select
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:border-red-500 focus:outline-none"
            >
              <option value="">All entities</option>
              {entityTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            {(search || actorFilter || entityFilter) && (
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                Clear
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="p-0">
          {filtered.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title={entries.length === 0 ? 'No activity yet' : 'No matching events'}
                description={
                  entries.length === 0
                    ? 'Actions taken across the workspace will be recorded here.'
                    : 'Try a different search or clear the filters.'
                }
                action={
                  entries.length > 0 ? (
                    <Button variant="secondary" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Time</TH>
                  <TH>Actor</TH>
                  <TH>Action</TH>
                  <TH>Entity</TH>
                  <TH>Details</TH>
                </TR>
              </THead>
              <TBody>
                {filtered.map((e) => {
                  const meta = metaSummary(e.metadata)
                  const open = expanded === e.id
                  return (
                    <TR key={e.id} className="align-top">
                      <TD className="whitespace-nowrap text-xs text-zinc-500">
                        {fmtDate(e.created_at)}
                      </TD>
                      <TD className="font-mono text-xs text-zinc-400">{e.actor_id ?? 'system'}</TD>
                      <TD>
                        <Badge tone={actionTone(e.action)}>{e.action ?? 'unknown'}</Badge>
                      </TD>
                      <TD>
                        <div className="text-zinc-300">{e.entity_type ?? '-'}</div>
                        {e.entity_id && (
                          <div className="font-mono text-xs text-zinc-600">{e.entity_id}</div>
                        )}
                      </TD>
                      <TD>
                        {meta ? (
                          <div className="max-w-md">
                            <button
                              onClick={() => setExpanded(open ? null : e.id)}
                              className="text-xs text-red-400 hover:text-red-300"
                            >
                              {open ? 'Hide' : 'Show'} metadata
                            </button>
                            {open && (
                              <pre className="mt-2 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-400">
                                {(() => {
                                  try {
                                    return JSON.stringify(
                                      typeof e.metadata === 'string'
                                        ? JSON.parse(e.metadata)
                                        : e.metadata,
                                      null,
                                      2,
                                    )
                                  } catch {
                                    return meta
                                  }
                                })()}
                              </pre>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-zinc-600">-</span>
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
