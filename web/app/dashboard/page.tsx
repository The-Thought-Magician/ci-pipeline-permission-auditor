'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import api from '@/lib/api'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Stat } from '@/components/ui/Stat'
import { Badge, severityTone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'

interface Workspace {
  id: string
  name: string
  slug?: string
}

interface SeverityMix {
  critical?: number
  high?: number
  medium?: number
  low?: number
  [k: string]: number | undefined
}

interface Overview {
  pipeline_count?: number
  pipelines?: number
  identity_count?: number
  identities?: number
  finding_count?: number
  findings?: number
  findings_by_severity?: SeverityMix
  severity_mix?: SeverityMix
  avg_risk_score?: number
  average_risk_score?: number
  crown_jewel_count?: number
  crown_jewels?: number
  crown_jewel_reachable?: number
  reachable_crown_jewels?: number
  reachable_crown_jewel_count?: number
  control_coverage?: number
  coverage?: number
  secret_count?: number
  secrets?: number
  provider_count?: number
  providers?: number
  [k: string]: unknown
}

interface TrendPoint {
  label: string
  score: number
}

function num(...vals: Array<number | undefined>): number {
  for (const v of vals) {
    if (typeof v === 'number' && !Number.isNaN(v)) return v
  }
  return 0
}

function fmtScore(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function riskAccent(score: number): 'red' | 'amber' | 'emerald' {
  if (score >= 70) return 'red'
  if (score >= 40) return 'amber'
  return 'emerald'
}

function RiskTrendChart({ points }: { points: TrendPoint[] }) {
  if (points.length === 0) {
    return <p className="text-sm text-slate-500">No snapshots yet. Risk trend appears once you capture posture snapshots.</p>
  }
  const W = 720
  const H = 200
  const pad = { top: 16, right: 16, bottom: 28, left: 32 }
  const innerW = W - pad.left - pad.right
  const innerH = H - pad.top - pad.bottom
  const max = Math.max(100, ...points.map((p) => p.score))
  const min = 0
  const n = points.length
  const x = (i: number) => pad.left + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const y = (s: number) => pad.top + innerH - ((s - min) / (max - min)) * innerH
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.score).toFixed(1)}`).join(' ')
  const area = `${line} L ${x(n - 1).toFixed(1)} ${(pad.top + innerH).toFixed(1)} L ${x(0).toFixed(1)} ${(pad.top + innerH).toFixed(1)} Z`
  const gridLines = [0, 25, 50, 75, 100]

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[480px]" role="img" aria-label="Risk score trend">
        <defs>
          <linearGradient id="riskArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(239 68 68)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="rgb(239 68 68)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {gridLines.map((g) => (
          <g key={g}>
            <line
              x1={pad.left}
              x2={W - pad.right}
              y1={y(g)}
              y2={y(g)}
              stroke="rgb(39 39 42)"
              strokeWidth={1}
            />
            <text x={4} y={y(g) + 4} fontSize={10} fill="rgb(113 113 122)">
              {g}
            </text>
          </g>
        ))}
        <path d={area} fill="url(#riskArea)" />
        <path d={line} fill="none" stroke="rgb(248 113 113)" strokeWidth={2} />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(p.score)} r={3} fill="rgb(248 113 113)" />
            {(n <= 12 || i % Math.ceil(n / 8) === 0) && (
              <text x={x(i)} y={H - 8} fontSize={10} fill="rgb(113 113 122)" textAnchor="middle">
                {p.label}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  )
}

export default function DashboardPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState<string>('')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [trend, setTrend] = useState<TrendPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [seeding, setSeeding] = useState(false)

  const loadData = useCallback(async (wsId: string) => {
    try {
      setError(null)
      const [ov, tr] = await Promise.all([api.getOverview(wsId), api.getRiskTrend(wsId)])
      setOverview(ov ?? {})
      const points: TrendPoint[] = Array.isArray(tr)
        ? tr.map((p: any) => ({ label: String(p.label ?? ''), score: num(p.score) }))
        : []
      setTrend(points)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load posture overview')
    }
  }, [])

  const init = useCallback(async () => {
    setLoading(true)
    try {
      setError(null)
      const ws: Workspace[] = (await api.listWorkspaces()) ?? []
      setWorkspaces(ws)
      if (ws.length > 0) {
        const chosen = ws[0].id
        setWorkspaceId(chosen)
        await loadData(chosen)
      } else {
        setOverview(null)
        setTrend([])
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load workspaces')
    } finally {
      setLoading(false)
    }
  }, [loadData])

  useEffect(() => {
    init()
  }, [init])

  const onSelectWorkspace = async (id: string) => {
    setWorkspaceId(id)
    setLoading(true)
    await loadData(id)
    setLoading(false)
  }

  const onSeed = async () => {
    setSeeding(true)
    setError(null)
    try {
      await api.seedSample()
      await init()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to seed sample data')
    } finally {
      setSeeding(false)
    }
  }

  const mix: SeverityMix = useMemo(() => {
    return overview?.findings_by_severity ?? overview?.severity_mix ?? {}
  }, [overview])

  const pipelineCount = num(overview?.pipeline_count, overview?.pipelines)
  const identityCount = num(overview?.identity_count, overview?.identities)
  const findingCount = num(
    overview?.finding_count,
    overview?.findings,
    (mix.critical ?? 0) + (mix.high ?? 0) + (mix.medium ?? 0) + (mix.low ?? 0),
  )
  const avgRisk = num(overview?.avg_risk_score, overview?.average_risk_score)
  const crownTotal = num(overview?.crown_jewel_count, overview?.crown_jewels)
  const crownReachable = num(
    overview?.reachable_crown_jewel_count,
    overview?.crown_jewel_reachable,
    overview?.reachable_crown_jewels,
  )
  const coverage = num(overview?.control_coverage, overview?.coverage)
  const secretCount = num(overview?.secret_count, overview?.secrets)
  const providerCount = num(overview?.provider_count, overview?.providers)

  const isEmpty = workspaces.length === 0

  if (loading && !overview && !isEmpty) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner label="Loading posture overview..." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100">Security Posture</h1>
          <p className="mt-1 text-sm text-slate-500">
            CI/CD pipeline permission and blast-radius overview.
          </p>
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
          {!isEmpty && (
            <Button variant="secondary" size="sm" onClick={() => onSelectWorkspace(workspaceId)} disabled={loading}>
              Refresh
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {isEmpty ? (
        <EmptyState
          title="No workspace yet"
          description="Seed a fully populated sample workspace to explore the auditor: providers, pipelines, identities, findings, blast radius, and more."
          icon={<span className="text-4xl">🛡️</span>}
          action={
            <Button onClick={onSeed} disabled={seeding}>
              {seeding ? <Spinner label="Seeding..." /> : 'Seed sample data'}
            </Button>
          }
        />
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Pipelines" value={pipelineCount} hint={`${providerCount} providers`} />
            <Stat label="Identities" value={identityCount} hint={`${secretCount} secrets tracked`} />
            <Stat
              label="Avg Risk Score"
              value={fmtScore(avgRisk)}
              accent={riskAccent(avgRisk)}
              hint="0 (safe) - 100 (critical)"
            />
            <Stat
              label="Open Findings"
              value={findingCount}
              accent={findingCount > 0 ? 'amber' : 'emerald'}
              hint={`${num(mix.critical)} critical / ${num(mix.high)} high`}
            />
          </div>

          {/* Severity breakdown + crown jewels + coverage */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Findings by Severity</CardTitle>
              </CardHeader>
              <CardBody className="space-y-3">
                {(['critical', 'high', 'medium', 'low'] as const).map((sev) => {
                  const v = num(mix[sev])
                  const total = Math.max(
                    1,
                    num(mix.critical) + num(mix.high) + num(mix.medium) + num(mix.low),
                  )
                  const pct = Math.round((v / total) * 100)
                  return (
                    <div key={sev}>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span className="flex items-center gap-2">
                          <Badge tone={severityTone(sev)}>{sev}</Badge>
                        </span>
                        <span className="text-slate-400">{v}</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                        <div
                          className={
                            sev === 'critical'
                              ? 'h-full rounded-full bg-red-500'
                              : sev === 'high'
                                ? 'h-full rounded-full bg-orange-500'
                                : sev === 'medium'
                                  ? 'h-full rounded-full bg-amber-500'
                                  : 'h-full rounded-full bg-sky-500'
                          }
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
                {findingCount === 0 && (
                  <p className="text-sm text-emerald-400">No open findings. Posture is clean.</p>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Crown-Jewel Reachability</CardTitle>
              </CardHeader>
              <CardBody>
                <div className="flex items-baseline gap-2">
                  <span className={`text-3xl font-bold ${crownReachable > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                    {crownReachable}
                  </span>
                  <span className="text-sm text-slate-500">of {crownTotal} reachable</span>
                </div>
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-red-500"
                    style={{ width: `${crownTotal > 0 ? Math.round((crownReachable / crownTotal) * 100) : 0}%` }}
                  />
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  Crown jewels a compromised pipeline could reach via effective permissions.
                </p>
                <Link
                  href="/dashboard/blast-radius"
                  className="mt-3 inline-block text-xs font-medium text-red-400 hover:text-red-300"
                >
                  View blast radius →
                </Link>
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Control Coverage</CardTitle>
              </CardHeader>
              <CardBody>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-slate-100">{Math.round(coverage <= 1 ? coverage * 100 : coverage)}%</span>
                  <span className="text-sm text-slate-500">controls covered</span>
                </div>
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-emerald-500"
                    style={{ width: `${Math.round(coverage <= 1 ? coverage * 100 : coverage)}%` }}
                  />
                </div>
                <p className="mt-3 text-xs text-slate-500">SOC2 / SLSA control coverage from evidence packs.</p>
                <Link
                  href="/dashboard/evidence"
                  className="mt-3 inline-block text-xs font-medium text-red-400 hover:text-red-300"
                >
                  View evidence →
                </Link>
              </CardBody>
            </Card>
          </div>

          {/* Risk trend */}
          <Card>
            <CardHeader>
              <CardTitle>Risk Score Trend</CardTitle>
            </CardHeader>
            <CardBody>
              <RiskTrendChart points={trend} />
            </CardBody>
          </Card>

          {/* Quick links */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              { href: '/dashboard/pipelines', label: 'Pipelines', desc: 'Inventory & risk' },
              { href: '/dashboard/findings', label: 'Findings', desc: 'Triage & remediate' },
              { href: '/dashboard/providers', label: 'Providers', desc: 'Connect & sync' },
              { href: '/dashboard/recommendations', label: 'Recommendations', desc: 'Least privilege' },
            ].map((q) => (
              <Link
                key={q.href}
                href={q.href}
                className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 transition-colors hover:border-slate-700 hover:bg-slate-900"
              >
                <div className="text-sm font-semibold text-slate-100">{q.label}</div>
                <div className="mt-0.5 text-xs text-slate-500">{q.desc}</div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
