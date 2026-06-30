'use client'

import { useMemo, useState } from 'react'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge, severityTone } from '@/components/ui/Badge'
import { Stat } from '@/components/ui/Stat'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'

interface ParsedStep {
  name?: string
  uses?: string
  run?: string
  [key: string]: unknown
}

interface ParsedJob {
  name?: string
  id?: string
  permissions?: Record<string, string> | string
  steps?: ParsedStep[]
  [key: string]: unknown
}

interface ParseResult {
  jobs?: ParsedJob[]
  steps?: ParsedStep[]
  permissions?: Record<string, string> | Record<string, unknown> | string
  uses?: string[]
  secrets?: string[]
  [key: string]: unknown
}

interface InlineFinding {
  detector?: string
  title: string
  description?: string
  severity: string
  evidence?: unknown
  [key: string]: unknown
}

interface AnalyzeResult {
  findings?: InlineFinding[]
  risk_score?: number
  recommended_permissions?: Record<string, string> | Record<string, unknown>
  [key: string]: unknown
}

const SAMPLE = `name: deploy
on:
  push:
    branches: [main]
permissions: write-all
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v1
        with:
          role-to-assume: arn:aws:iam::123456789012:role/deploy
      - run: ./deploy.sh
        env:
          AWS_SECRET: \${{ secrets.AWS_SECRET }}
`

const FORMATS = [
  { value: 'github_actions', label: 'GitHub Actions (YAML)' },
  { value: 'gitlab_ci', label: 'GitLab CI (YAML)' },
  { value: 'jenkins', label: 'Jenkinsfile' },
]

function riskAccent(score: number): 'red' | 'amber' | 'emerald' {
  if (score >= 70) return 'red'
  if (score >= 40) return 'amber'
  return 'emerald'
}

function permEntries(
  perms: Record<string, unknown> | string | undefined,
): { key: string; value: string }[] {
  if (!perms) return []
  if (typeof perms === 'string') return [{ key: 'permissions', value: perms }]
  return Object.entries(perms).map(([key, value]) => ({ key, value: String(value) }))
}

export default function AnalyzerPage() {
  const [source, setSource] = useState('')
  const [format, setFormat] = useState('github_actions')
  const [parsing, setParsing] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null)

  const body = useMemo(() => ({ source, format, raw_source: source, kind: format }), [source, format])

  const runParse = async () => {
    if (!source.trim()) {
      setError('Paste a workflow to analyze first')
      return
    }
    setParsing(true)
    setError(null)
    try {
      const res: ParseResult = await api.parseWorkflow(body)
      setParsed(res || {})
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse workflow')
    } finally {
      setParsing(false)
    }
  }

  const runAnalyze = async () => {
    if (!source.trim()) {
      setError('Paste a workflow to analyze first')
      return
    }
    setParsing(true)
    setAnalyzing(true)
    setError(null)
    try {
      const [p, a]: [ParseResult, AnalyzeResult] = await Promise.all([
        api.parseWorkflow(body),
        api.analyzeWorkflow(body),
      ])
      setParsed(p || {})
      setAnalysis(a || {})
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to analyze workflow')
    } finally {
      setParsing(false)
      setAnalyzing(false)
    }
  }

  const reset = () => {
    setSource('')
    setParsed(null)
    setAnalysis(null)
    setError(null)
  }

  const jobs = parsed?.jobs ?? []
  const steps = parsed?.steps ?? jobs.flatMap((j) => j.steps ?? [])
  const usesList = parsed?.uses ?? []
  const secretsList = parsed?.secrets ?? []
  const findings = analysis?.findings ?? []

  const sevCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    findings.forEach((f) => {
      const s = (f.severity || 'unknown').toLowerCase()
      counts[s] = (counts[s] ?? 0) + 1
    })
    return counts
  }, [findings])

  const busy = parsing || analyzing
  const hasResult = parsed !== null || analysis !== null

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-zinc-100">Workflow Analyzer</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Paste any CI workflow to get an inline least-privilege and risk read-out. Nothing is stored, this is a
            throwaway analysis.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
          >
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Workflow source</CardTitle>
          <button className="text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setSource(SAMPLE)}>
            Load sample
          </button>
        </CardHeader>
        <CardBody className="space-y-4">
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            rows={16}
            spellCheck={false}
            placeholder="Paste your .github/workflows/*.yml, .gitlab-ci.yml, or Jenkinsfile here..."
            className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-200 placeholder:text-zinc-600"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={runAnalyze} disabled={busy || !source.trim()}>
              {busy ? 'Analyzing...' : 'Analyze'}
            </Button>
            <Button variant="secondary" onClick={runParse} disabled={busy || !source.trim()}>
              Parse only
            </Button>
            <Button variant="ghost" onClick={reset} disabled={busy}>
              Clear
            </Button>
            <span className="ml-auto text-xs text-zinc-600">{source.length} chars</span>
          </div>
        </CardBody>
      </Card>

      {busy && (
        <div className="flex justify-center py-8">
          <Spinner label={analyzing ? 'Running least-privilege analysis...' : 'Parsing workflow...'} />
        </div>
      )}

      {!busy && !hasResult && (
        <EmptyState
          title="Nothing analyzed yet"
          description="Paste a workflow above and hit Analyze to see parsed jobs, used Actions, referenced secrets, inline findings, and the minimum permission set."
        />
      )}

      {!busy && analysis && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <Stat
            label="Risk score"
            value={typeof analysis.risk_score === 'number' ? Math.round(analysis.risk_score) : '—'}
            accent={typeof analysis.risk_score === 'number' ? riskAccent(analysis.risk_score) : 'default'}
            hint="0–100, higher is riskier"
          />
          <Stat label="Findings" value={findings.length} accent={findings.length ? 'amber' : 'emerald'} />
          <Stat label="Critical" value={sevCounts.critical ?? 0} accent={(sevCounts.critical ?? 0) ? 'red' : 'default'} />
          <Stat label="High" value={sevCounts.high ?? 0} accent={(sevCounts.high ?? 0) ? 'red' : 'default'} />
          <Stat label="Secrets" value={secretsList.length} accent={secretsList.length ? 'amber' : 'default'} />
        </div>
      )}

      {!busy && analysis && (
        <Card>
          <CardHeader>
            <CardTitle>Inline findings</CardTitle>
          </CardHeader>
          <CardBody>
            {findings.length === 0 ? (
              <p className="text-sm text-emerald-400">No least-privilege or risk findings. This workflow looks clean.</p>
            ) : (
              <div className="space-y-2">
                {findings.map((f, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
                      {f.detector && <span className="text-xs text-zinc-500">{f.detector}</span>}
                      <span className="font-medium text-zinc-100">{f.title}</span>
                    </div>
                    {f.description && <p className="mt-1 text-sm text-zinc-400">{f.description}</p>}
                    {f.evidence != null && (
                      <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-400">
                        {typeof f.evidence === 'string' ? f.evidence : JSON.stringify(f.evidence, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {!busy && analysis && (
        <Card>
          <CardHeader>
            <CardTitle>Recommended minimum permissions</CardTitle>
          </CardHeader>
          <CardBody>
            {(() => {
              const recs = permEntries(analysis.recommended_permissions as Record<string, unknown> | undefined)
              if (recs.length === 0) {
                return <p className="text-sm text-zinc-500">No recommended permission set was returned.</p>
              }
              return (
                <div className="space-y-3">
                  <p className="text-sm text-zinc-400">
                    Replace the declared permission block with this least-privilege set:
                  </p>
                  <pre className="overflow-auto rounded-lg border border-emerald-900 bg-emerald-950/20 p-3 text-xs text-emerald-300">
                    {`permissions:\n${recs.map((r) => `  ${r.key}: ${r.value}`).join('\n')}`}
                  </pre>
                </div>
              )
            })()}
          </CardBody>
        </Card>
      )}

      {!busy && parsed && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Declared permissions</CardTitle>
            </CardHeader>
            <CardBody>
              {(() => {
                const entries = permEntries(parsed.permissions as Record<string, unknown> | string | undefined)
                if (entries.length === 0) {
                  return <p className="text-sm text-zinc-500">No top-level permissions block declared.</p>
                }
                return (
                  <div className="flex flex-wrap gap-2">
                    {entries.map((e) => {
                      const broad = /write|all|admin/i.test(e.value) || /write|all|admin/i.test(e.key)
                      return (
                        <Badge key={e.key} tone={broad ? 'high' : 'neutral'}>
                          {e.key}: {e.value}
                        </Badge>
                      )
                    })}
                  </div>
                )
              })()}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Referenced secrets ({secretsList.length})</CardTitle>
            </CardHeader>
            <CardBody>
              {secretsList.length === 0 ? (
                <p className="text-sm text-zinc-500">No secrets referenced.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {secretsList.map((s) => (
                    <Badge key={s} tone="warning">
                      {s}
                    </Badge>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Third-party Actions used ({usesList.length})</CardTitle>
            </CardHeader>
            <CardBody>
              {usesList.length === 0 ? (
                <p className="text-sm text-zinc-500">No third-party Actions detected.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {usesList.map((u) => {
                    const pinnedToSha = /@[0-9a-f]{40}$/i.test(u)
                    return (
                      <Badge key={u} tone={pinnedToSha ? 'success' : 'high'}>
                        {u}
                        {pinnedToSha ? ' ✓' : ' (tag)'}
                      </Badge>
                    )
                  })}
                </div>
              )}
            </CardBody>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Parsed jobs &amp; steps</CardTitle>
            </CardHeader>
            <CardBody>
              {jobs.length === 0 && steps.length === 0 ? (
                <p className="text-sm text-zinc-500">No jobs or steps parsed.</p>
              ) : jobs.length > 0 ? (
                <div className="space-y-4">
                  {jobs.map((job, i) => (
                    <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span className="font-medium text-zinc-100">{job.name || job.id || `job ${i + 1}`}</span>
                        {permEntries(job.permissions as Record<string, unknown> | string | undefined).map((p) => (
                          <Badge key={p.key} tone="neutral">
                            {p.key}: {p.value}
                          </Badge>
                        ))}
                      </div>
                      {(job.steps ?? []).length > 0 ? (
                        <ol className="space-y-1 text-sm">
                          {(job.steps ?? []).map((st, j) => (
                            <li key={j} className="flex items-start gap-2 text-zinc-400">
                              <span className="text-zinc-600">{j + 1}.</span>
                              <span>
                                {st.name && <span className="text-zinc-300">{st.name} </span>}
                                {st.uses && <span className="font-mono text-xs text-sky-400">uses: {st.uses}</span>}
                                {st.run && <span className="font-mono text-xs text-zinc-500">run: {String(st.run).slice(0, 80)}</span>}
                              </span>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className="text-xs text-zinc-600">No steps in this job.</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH className="w-12">#</TH>
                      <TH>Name</TH>
                      <TH>Uses / Run</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {steps.map((st, i) => (
                      <TR key={i}>
                        <TD className="text-zinc-600">{i + 1}</TD>
                        <TD>{st.name || '—'}</TD>
                        <TD className="font-mono text-xs">
                          {st.uses ? (
                            <span className="text-sky-400">{st.uses}</span>
                          ) : st.run ? (
                            <span className="text-zinc-500">{String(st.run).slice(0, 120)}</span>
                          ) : (
                            '—'
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
      )}
    </div>
  )
}
