'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge, severityTone } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Stat } from '@/components/ui/Stat'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'

interface Identity {
  id: string
  name: string
  identity_type?: string
  credential_kind?: string
  is_long_lived?: boolean
  environment?: string
}

interface PipelineAction {
  id: string
  name?: string
  step_name?: string
  publisher?: string
  pin_type?: string
  pin_ref?: string
  risk_level?: string
  is_verified_publisher?: boolean
}

interface EffectivePermission {
  id: string
  action: string
  category?: string
  is_excess?: boolean
  source_chain?: unknown
}

interface BlastRadius {
  id?: string
  pipeline_id?: string
  score?: number
  reachable_resource_ids?: string[]
  reachable_secret_ids?: string[]
  reachable_pipeline_ids?: string[]
  crown_jewel_count?: number
  summary?: string
  computed_at?: string | null
}

interface PipelineDetail {
  id: string
  name: string
  repo?: string
  branch?: string
  file_path?: string
  risk_score?: number
  triggers?: unknown
  declared_permissions?: Record<string, string> | unknown
  raw_source?: string
  identities?: Identity[]
  actions?: PipelineAction[]
  effective_permissions?: EffectivePermission[]
  blast_radius?: BlastRadius | null
}

function declaredToPairs(declared: unknown): { scope: string; level: string }[] {
  if (!declared) return []
  if (Array.isArray(declared)) {
    return declared.map((d) =>
      typeof d === 'string'
        ? { scope: d, level: 'write' }
        : { scope: String((d as any).scope ?? (d as any).name ?? ''), level: String((d as any).level ?? (d as any).access ?? 'write') },
    )
  }
  if (typeof declared === 'object') {
    return Object.entries(declared as Record<string, unknown>).map(([scope, level]) => ({
      scope,
      level: String(level),
    }))
  }
  return []
}

function riskAccent(score?: number): 'red' | 'amber' | 'emerald' {
  const s = score ?? 0
  if (s >= 70) return 'red'
  if (s >= 40) return 'amber'
  return 'emerald'
}

export default function PipelineDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const pipelineId = params?.id

  const [pipeline, setPipeline] = useState<PipelineDetail | null>(null)
  const [effective, setEffective] = useState<EffectivePermission[]>([])
  const [blast, setBlast] = useState<BlastRadius | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [analyzing, setAnalyzing] = useState(false)
  const [computing, setComputing] = useState(false)
  const [savingPerms, setSavingPerms] = useState(false)

  // What-if simulation
  const [removeSet, setRemoveSet] = useState<Set<string>>(new Set())
  const [simulating, setSimulating] = useState(false)
  const [simResult, setSimResult] = useState<{ before: number; after: number; delta: number } | null>(null)

  // Declared-permission editor
  const [editingPerms, setEditingPerms] = useState(false)
  const [permDraft, setPermDraft] = useState<{ scope: string; level: string }[]>([])

  const load = useCallback(async () => {
    if (!pipelineId) return
    setError(null)
    try {
      const detail: PipelineDetail = await api.getPipeline(pipelineId)
      setPipeline(detail)
      setEffective(detail.effective_permissions ?? [])
      setBlast(detail.blast_radius ?? null)
      // Fetch dedicated blast-radius record (may have more detail than the join).
      try {
        const br: BlastRadius = await api.getBlastRadius(pipelineId)
        if (br && (br.score != null || br.summary)) setBlast(br)
      } catch {
        // no blast radius computed yet — fine
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load pipeline')
    }
  }, [pipelineId])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      await load()
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  // Fall back to listEffective when the detail join is empty.
  useEffect(() => {
    if (!pipeline) return
    if (effective.length > 0) return
    let cancelled = false
    ;(async () => {
      try {
        const ws = await api.listWorkspaces()
        const first = Array.isArray(ws) && ws.length > 0 ? ws[0] : null
        if (!first) return
        const all = await api.listEffective(first.id)
        if (cancelled || !Array.isArray(all)) return
        const mine = all.filter((p: any) => p.pipeline_id === pipelineId)
        if (mine.length > 0) setEffective(mine)
      } catch {
        // ignore
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline])

  async function analyze() {
    if (!pipelineId) return
    setAnalyzing(true)
    setError(null)
    setNotice(null)
    try {
      const updated: PipelineDetail = await api.analyzePipeline(pipelineId)
      setNotice(`Risk re-scored: ${Math.round((updated.risk_score ?? 0) as number)}.`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Analyze failed')
    } finally {
      setAnalyzing(false)
    }
  }

  async function computeBlast() {
    if (!pipeline) return
    setComputing(true)
    setError(null)
    setNotice(null)
    try {
      const ws = await api.listWorkspaces()
      const first = Array.isArray(ws) && ws.length > 0 ? ws[0] : null
      await api.computeBlastRadius({ workspace_id: first?.id, pipeline_id: pipelineId })
      setNotice('Blast radius recomputed.')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Compute failed')
    } finally {
      setComputing(false)
    }
  }

  function toggleRemove(action: string) {
    setRemoveSet((prev) => {
      const next = new Set(prev)
      if (next.has(action)) next.delete(action)
      else next.add(action)
      return next
    })
    setSimResult(null)
  }

  async function simulate() {
    if (!pipelineId || removeSet.size === 0) return
    setSimulating(true)
    setError(null)
    try {
      const res = await api.simulateBlastRadius({
        pipeline_id: pipelineId,
        remove: Array.from(removeSet),
      })
      setSimResult({
        before: res?.before ?? 0,
        after: res?.after ?? 0,
        delta: res?.delta ?? (res?.before ?? 0) - (res?.after ?? 0),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Simulation failed')
    } finally {
      setSimulating(false)
    }
  }

  // ---- Declared-permission editing ----
  function startEditPerms() {
    setPermDraft(declaredToPairs(pipeline?.declared_permissions))
    setEditingPerms(true)
  }
  function updateDraft(i: number, patch: Partial<{ scope: string; level: string }>) {
    setPermDraft((d) => d.map((p, idx) => (idx === i ? { ...p, ...patch } : p)))
  }
  function addDraftRow() {
    setPermDraft((d) => [...d, { scope: '', level: 'read' }])
  }
  function removeDraftRow(i: number) {
    setPermDraft((d) => d.filter((_, idx) => idx !== i))
  }
  async function savePerms() {
    if (!pipelineId) return
    setSavingPerms(true)
    setError(null)
    try {
      const declared_permissions: Record<string, string> = {}
      permDraft.forEach((p) => {
        if (p.scope.trim()) declared_permissions[p.scope.trim()] = p.level
      })
      await api.updatePipeline(pipelineId, { declared_permissions })
      setEditingPerms(false)
      setNotice('Declared permissions updated. Re-analyze to refresh risk.')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSavingPerms(false)
    }
  }

  const declaredPairs = useMemo(
    () => declaredToPairs(pipeline?.declared_permissions),
    [pipeline],
  )
  const excessCount = useMemo(() => effective.filter((e) => e.is_excess).length, [effective])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner label="Loading pipeline..." />
      </div>
    )
  }

  if (error && !pipeline) {
    return (
      <div className="mx-auto max-w-3xl py-12 space-y-4">
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
        <Button variant="secondary" onClick={() => router.push('/dashboard/pipelines')}>
          Back to pipelines
        </Button>
      </div>
    )
  }

  if (!pipeline) {
    return (
      <div className="mx-auto max-w-3xl py-12">
        <EmptyState
          title="Pipeline not found"
          description="This pipeline may have been deleted."
          action={
            <Button variant="secondary" onClick={() => router.push('/dashboard/pipelines')}>
              Back to pipelines
            </Button>
          }
        />
      </div>
    )
  }

  const blastScore = blast?.score ?? 0
  const reachResources = blast?.reachable_resource_ids?.length ?? 0
  const reachSecrets = blast?.reachable_secret_ids?.length ?? 0
  const reachPipelines = blast?.reachable_pipeline_ids?.length ?? 0
  const crownJewels = blast?.crown_jewel_count ?? 0

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <button
            onClick={() => router.push('/dashboard/pipelines')}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            ← Pipelines
          </button>
          <h1 className="mt-1 text-xl font-bold text-zinc-100">{pipeline.name}</h1>
          <p className="mt-1 font-mono text-sm text-zinc-500">
            {pipeline.repo}
            {pipeline.branch ? ` @ ${pipeline.branch}` : ''}
            {pipeline.file_path ? ` · ${pipeline.file_path}` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={computeBlast} disabled={computing}>
            {computing ? <Spinner /> : 'Compute blast radius'}
          </Button>
          <Button onClick={analyze} disabled={analyzing}>
            {analyzing ? <Spinner /> : 'Re-analyze risk'}
          </Button>
        </div>
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
        <Stat
          label="Risk score"
          value={Math.round((pipeline.risk_score ?? 0) as number)}
          accent={riskAccent(pipeline.risk_score)}
        />
        <Stat
          label="Excess perms"
          value={excessCount}
          accent={excessCount > 0 ? 'red' : 'emerald'}
          hint={`${effective.length} effective`}
        />
        <Stat
          label="Blast score"
          value={Math.round(blastScore)}
          accent={riskAccent(blastScore)}
        />
        <Stat
          label="Crown jewels"
          value={crownJewels}
          accent={crownJewels > 0 ? 'red' : 'emerald'}
          hint="reachable"
        />
      </div>

      {/* Declared vs effective */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Declared permissions</CardTitle>
              {editingPerms ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setEditingPerms(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={savePerms} disabled={savingPerms}>
                    {savingPerms ? <Spinner /> : 'Save'}
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="secondary" onClick={startEditPerms}>
                  Edit
                </Button>
              )}
            </div>
          </CardHeader>
          <CardBody>
            {editingPerms ? (
              <div className="space-y-2">
                {permDraft.map((p, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={p.scope}
                      onChange={(e) => updateDraft(i, { scope: e.target.value })}
                      placeholder="contents"
                      className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-mono text-xs text-zinc-100 focus:border-red-500 focus:outline-none"
                    />
                    <select
                      value={p.level}
                      onChange={(e) => updateDraft(i, { level: e.target.value })}
                      className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 focus:border-red-500 focus:outline-none"
                    >
                      <option value="read">read</option>
                      <option value="write">write</option>
                      <option value="none">none</option>
                    </select>
                    <button
                      onClick={() => removeDraftRow(i)}
                      className="text-zinc-500 hover:text-red-400"
                      aria-label="Remove"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <Button size="sm" variant="ghost" onClick={addDraftRow}>
                  + Add scope
                </Button>
              </div>
            ) : declaredPairs.length === 0 ? (
              <p className="text-sm text-zinc-500">No declared permissions on this pipeline.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {declaredPairs.map((p) => (
                  <span
                    key={p.scope}
                    className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs"
                  >
                    <span className="font-mono text-zinc-300">{p.scope}</span>
                    <Badge tone={p.level === 'write' ? 'high' : p.level === 'none' ? 'neutral' : 'low'}>
                      {p.level}
                    </Badge>
                  </span>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Effective permissions ({effective.length})</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {effective.length === 0 ? (
              <div className="px-5 py-4 text-sm text-zinc-500">
                No effective permissions resolved. Run the resolver from the Effective Permissions page.
              </div>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Action</TH>
                    <TH>Category</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {effective.map((e) => (
                    <TR key={e.id}>
                      <TD className="font-mono text-xs text-zinc-300">{e.action}</TD>
                      <TD>{e.category ? <Badge tone="info">{e.category}</Badge> : '-'}</TD>
                      <TD>
                        {e.is_excess ? (
                          <Badge tone="critical">excess</Badge>
                        ) : (
                          <Badge tone="success">justified</Badge>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Identities + actions */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Identities ({pipeline.identities?.length ?? 0})</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {!pipeline.identities || pipeline.identities.length === 0 ? (
              <div className="px-5 py-4 text-sm text-zinc-500">No identities attached.</div>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Type</TH>
                    <TH>Credential</TH>
                  </TR>
                </THead>
                <TBody>
                  {pipeline.identities.map((i) => (
                    <TR key={i.id}>
                      <TD className="font-medium text-zinc-200">{i.name}</TD>
                      <TD>
                        <Badge tone="info">{i.identity_type ?? '-'}</Badge>
                      </TD>
                      <TD>
                        <span className="font-mono text-xs">{i.credential_kind ?? '-'}</span>
                        {i.is_long_lived && (
                          <Badge tone="critical" className="ml-2">
                            long-lived
                          </Badge>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Third-party actions ({pipeline.actions?.length ?? 0})</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {!pipeline.actions || pipeline.actions.length === 0 ? (
              <div className="px-5 py-4 text-sm text-zinc-500">No third-party actions used.</div>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Action</TH>
                    <TH>Pin</TH>
                    <TH>Risk</TH>
                  </TR>
                </THead>
                <TBody>
                  {pipeline.actions.map((a) => (
                    <TR key={a.id}>
                      <TD className="font-mono text-xs text-zinc-300">
                        {a.name ?? a.step_name ?? a.id}
                        {a.is_verified_publisher && (
                          <Badge tone="success" className="ml-2">
                            verified
                          </Badge>
                        )}
                      </TD>
                      <TD>
                        <Badge tone={a.pin_type === 'sha' ? 'success' : 'medium'}>
                          {a.pin_type ?? 'unpinned'}
                        </Badge>
                      </TD>
                      <TD>
                        {a.risk_level ? (
                          <Badge tone={severityTone(a.risk_level)}>{a.risk_level}</Badge>
                        ) : (
                          '-'
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Blast radius */}
      <Card>
        <CardHeader>
          <CardTitle>Blast radius</CardTitle>
        </CardHeader>
        <CardBody>
          {!blast || (blast.score == null && !blast.summary) ? (
            <EmptyState
              title="Blast radius not computed"
              description="Compute the blast radius to see which resources, secrets, and pipelines this one can reach."
              action={
                <Button onClick={computeBlast} disabled={computing}>
                  {computing ? <Spinner /> : 'Compute blast radius'}
                </Button>
              }
            />
          ) : (
            <div className="space-y-4">
              {blast.summary && <p className="text-sm text-zinc-400">{blast.summary}</p>}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Reachable resources" value={reachResources} accent="sky" />
                <Stat label="Reachable secrets" value={reachSecrets} accent="amber" />
                <Stat label="Reachable pipelines" value={reachPipelines} accent="sky" />
                <Stat
                  label="Crown jewels"
                  value={crownJewels}
                  accent={crownJewels > 0 ? 'red' : 'emerald'}
                />
              </div>
              {/* Simple SVG-free bar of the score */}
              <div>
                <div className="mb-1 flex items-center justify-between text-xs text-zinc-500">
                  <span>Blast score</span>
                  <span>{Math.round(blastScore)} / 100</span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className={`h-full ${
                      blastScore >= 70 ? 'bg-red-500' : blastScore >= 40 ? 'bg-amber-500' : 'bg-emerald-500'
                    }`}
                    style={{ width: `${Math.min(100, Math.max(2, blastScore))}%` }}
                  />
                </div>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {/* What-if simulation */}
      <Card>
        <CardHeader>
          <CardTitle>What-if simulation</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="mb-4 text-sm text-zinc-500">
            Select effective permissions to remove and re-score the blast radius without changing the pipeline.
          </p>
          {effective.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No effective permissions to simulate. Resolve permissions first.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {effective.map((e) => {
                  const active = removeSet.has(e.action)
                  return (
                    <button
                      key={e.id}
                      onClick={() => toggleRemove(e.action)}
                      className={`rounded-lg border px-2.5 py-1 font-mono text-xs transition-colors ${
                        active
                          ? 'border-red-700 bg-red-950 text-red-300 line-through'
                          : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600'
                      }`}
                    >
                      {e.action}
                    </button>
                  )
                })}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button onClick={simulate} disabled={simulating || removeSet.size === 0}>
                  {simulating ? <Spinner /> : `Simulate (${removeSet.size} removed)`}
                </Button>
                {removeSet.size > 0 && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setRemoveSet(new Set())
                      setSimResult(null)
                    }}
                  >
                    Clear
                  </Button>
                )}
              </div>
              {simResult && (
                <div className="mt-4 grid grid-cols-3 gap-4">
                  <Stat label="Before" value={Math.round(simResult.before)} accent={riskAccent(simResult.before)} />
                  <Stat label="After" value={Math.round(simResult.after)} accent={riskAccent(simResult.after)} />
                  <Stat
                    label="Reduction"
                    value={Math.round(simResult.delta)}
                    accent={simResult.delta > 0 ? 'emerald' : 'default'}
                  />
                </div>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
