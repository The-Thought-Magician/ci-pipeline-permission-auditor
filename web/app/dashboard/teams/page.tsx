'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import api from '@/lib/api'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table'
import { Badge, severityTone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { Stat } from '@/components/ui/Stat'

interface Workspace {
  id: string
  name: string
}

interface FindingRollup {
  critical?: number
  high?: number
  medium?: number
  low?: number
  total?: number
  [k: string]: unknown
}

interface Team {
  id: string
  workspace_id: string
  name: string
  slug?: string | null
  owner_email?: string | null
  member_ids?: string[] | null
  // posture fields the list endpoint may attach
  pipeline_count?: number | null
  finding_count?: number | null
  risk_score?: number | null
  findings?: FindingRollup | null
  severity?: FindingRollup | null
  created_by?: string | null
  created_at?: string
}

interface PipelineLite {
  id: string
  name: string
  repo?: string | null
  branch?: string | null
  risk_score?: number | null
}

interface TeamDetail extends Team {
  pipelines?: PipelineLite[]
  finding_rollup?: FindingRollup
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function fmtDate(s?: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return String(s)
  return d.toLocaleString()
}

function rollupOf(t: Team | TeamDetail | null | undefined): FindingRollup {
  if (!t) return {}
  return (t as TeamDetail).finding_rollup ?? t.findings ?? t.severity ?? {}
}

function totalFindings(t: Team): number {
  const r = rollupOf(t)
  if (typeof r.total === 'number') return r.total
  const summed = num(r.critical) + num(r.high) + num(r.medium) + num(r.low)
  if (summed > 0) return summed
  return num(t.finding_count)
}

function memberList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function riskColor(score: number): string {
  if (score >= 70) return 'text-red-400'
  if (score >= 40) return 'text-amber-400'
  if (score > 0) return 'text-emerald-400'
  return 'text-zinc-300'
}

export default function TeamsPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [search, setSearch] = useState('')

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Team | null>(null)
  const [form, setForm] = useState({ name: '', slug: '', owner_email: '', members: '' })

  const [detail, setDetail] = useState<TeamDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const loadScoped = useCallback(async (wsId: string) => {
    const list = await api.listTeams(wsId)
    setTeams(Array.isArray(list) ? list : [])
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
      setError(e?.message ?? 'Failed to load teams')
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

  const openCreate = () => {
    setEditing(null)
    setForm({ name: '', slug: '', owner_email: '', members: '' })
    setFormOpen(true)
  }

  const openEdit = (t: Team) => {
    setEditing(t)
    setForm({
      name: t.name ?? '',
      slug: t.slug ?? '',
      owner_email: t.owner_email ?? '',
      members: (t.member_ids ?? []).join('\n'),
    })
    setFormOpen(true)
  }

  const saveTeam = async () => {
    if (!form.name.trim()) {
      setError('Team name is required')
      return
    }
    setBusy('save')
    setError(null)
    const members = memberList(form.members)
    try {
      if (editing) {
        await api.updateTeam(editing.id, {
          name: form.name.trim(),
          slug: form.slug.trim() || null,
          owner_email: form.owner_email.trim() || null,
          member_ids: members,
        })
      } else {
        await api.createTeam({
          workspace_id: workspaceId,
          name: form.name.trim(),
          slug: form.slug.trim() || null,
          owner_email: form.owner_email.trim() || null,
          member_ids: members,
        })
      }
      setFormOpen(false)
      await loadScoped(workspaceId)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save team')
    } finally {
      setBusy(null)
    }
  }

  const removeTeam = async (t: Team) => {
    if (!confirm(`Delete team "${t.name}"? Pipelines owned by it will be unassigned.`)) return
    setBusy(`del-${t.id}`)
    setError(null)
    try {
      await api.deleteTeam(t.id)
      if (detail?.id === t.id) setDetail(null)
      await loadScoped(workspaceId)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to delete team')
    } finally {
      setBusy(null)
    }
  }

  const openDetail = async (t: Team) => {
    setDetail(t as TeamDetail)
    setDetailLoading(true)
    try {
      const full = await api.getTeam(t.id)
      if (full) setDetail(full)
    } catch {
      // keep row data
    } finally {
      setDetailLoading(false)
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return teams
    return teams.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.slug ?? '').toLowerCase().includes(q) ||
        (t.owner_email ?? '').toLowerCase().includes(q),
    )
  }, [teams, search])

  const stats = useMemo(() => {
    const total = teams.length
    let pipelines = 0
    let findings = 0
    let critical = 0
    for (const t of teams) {
      pipelines += num(t.pipeline_count)
      findings += totalFindings(t)
      critical += num(rollupOf(t).critical)
    }
    return { total, pipelines, findings, critical }
  }, [teams])

  const detailPipelines = detail?.pipelines ?? []
  const detailRollup = rollupOf(detail)

  const isEmpty = workspaces.length === 0

  if (loading && teams.length === 0 && !isEmpty) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner label="Loading teams..." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-100">Teams & Ownership</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Per-team posture, finding rollups, and member management across owned pipelines.
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
          description="Create or seed a workspace from the dashboard before configuring teams."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Teams" value={stats.total} />
            <Stat label="Owned pipelines" value={stats.pipelines} accent="sky" />
            <Stat label="Open findings" value={stats.findings} accent={stats.findings > 0 ? 'amber' : 'emerald'} />
            <Stat label="Critical findings" value={stats.critical} accent={stats.critical > 0 ? 'red' : 'emerald'} />
          </div>

          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Teams</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search teams..."
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-500/60"
                />
                <Button size="sm" variant="secondary" onClick={refresh} disabled={loading}>
                  Refresh
                </Button>
                <Button size="sm" onClick={openCreate}>
                  New team
                </Button>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              {filtered.length === 0 ? (
                <div className="p-6">
                  <EmptyState
                    title={teams.length === 0 ? 'No teams' : 'No matching teams'}
                    description={
                      teams.length === 0
                        ? 'Create a team to assign pipeline ownership and roll up its security posture.'
                        : 'Adjust your search.'
                    }
                    action={teams.length === 0 ? <Button onClick={openCreate}>New team</Button> : undefined}
                  />
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Team</TH>
                      <TH>Owner</TH>
                      <TH>Members</TH>
                      <TH>Pipelines</TH>
                      <TH>Findings</TH>
                      <TH>Posture</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {filtered.map((t) => {
                      const r = rollupOf(t)
                      const findings = totalFindings(t)
                      const crit = num(r.critical)
                      const high = num(r.high)
                      return (
                        <TR key={t.id} className="cursor-pointer" onClick={() => openDetail(t)}>
                          <TD className="font-medium text-zinc-100">
                            {t.name}
                            {t.slug && <span className="ml-2 text-xs text-zinc-600">{t.slug}</span>}
                          </TD>
                          <TD className="text-zinc-400">{t.owner_email || '—'}</TD>
                          <TD className="text-zinc-500">{(t.member_ids ?? []).length}</TD>
                          <TD>{num(t.pipeline_count)}</TD>
                          <TD className={findings > 0 ? 'text-amber-400' : 'text-zinc-500'}>{findings}</TD>
                          <TD>
                            <div className="flex flex-wrap gap-1">
                              {crit > 0 && <Badge tone="critical">{crit} crit</Badge>}
                              {high > 0 && <Badge tone="high">{high} high</Badge>}
                              {crit === 0 && high === 0 && <Badge tone="success">clean</Badge>}
                            </div>
                          </TD>
                          <TD className="text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex justify-end gap-2">
                              <Button size="sm" variant="secondary" onClick={() => openDetail(t)}>
                                View
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => openEdit(t)}>
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => removeTeam(t)}
                                disabled={busy === `del-${t.id}`}
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

      {/* Create / edit modal */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Edit team' : 'New team'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveTeam} disabled={busy === 'save'}>
              {busy === 'save' ? 'Saving...' : editing ? 'Save changes' : 'Create team'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name">
            <TextInput value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="Platform Team" />
          </Field>
          <Field label="Slug">
            <TextInput value={form.slug} onChange={(v) => setForm({ ...form, slug: v })} placeholder="platform" />
          </Field>
          <Field label="Owner email">
            <TextInput
              value={form.owner_email}
              onChange={(v) => setForm({ ...form, owner_email: v })}
              placeholder="lead@acme-corp.com"
            />
          </Field>
          <Field label="Members (one per line or comma-separated)">
            <textarea
              value={form.members}
              onChange={(e) => setForm({ ...form, members: e.target.value })}
              rows={4}
              placeholder={'alice@acme-corp.com\nbob@acme-corp.com'}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-500/60"
            />
          </Field>
        </div>
      </Modal>

      {/* Detail modal */}
      <Modal
        open={detail != null}
        onClose={() => setDetail(null)}
        title={detail ? `Team · ${detail.name}` : 'Team'}
        size="lg"
        footer={
          detail ? (
            <>
              <Button variant="ghost" onClick={() => setDetail(null)}>
                Close
              </Button>
              <Button onClick={() => openEdit(detail)}>Edit team</Button>
            </>
          ) : undefined
        }
      >
        {detail && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              {detail.slug && <Badge tone="neutral">{detail.slug}</Badge>}
              {detail.owner_email && <Badge tone="info">owner: {detail.owner_email}</Badge>}
              <span className="text-xs text-zinc-500">Created {fmtDate(detail.created_at)}</span>
              {detailLoading && <Spinner label="Loading..." />}
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Pipelines" value={detailPipelines.length || num(detail.pipeline_count)} />
              <Stat
                label="Findings"
                value={num(detailRollup.total) || totalFindings(detail)}
                accent={totalFindings(detail) > 0 ? 'amber' : 'emerald'}
              />
              <Stat
                label="Critical"
                value={num(detailRollup.critical)}
                accent={num(detailRollup.critical) > 0 ? 'red' : 'emerald'}
              />
              <Stat label="Members" value={(detail.member_ids ?? []).length} />
            </div>

            {/* Finding rollup */}
            {(['critical', 'high', 'medium', 'low'] as const).some((k) => num(detailRollup[k]) > 0) && (
              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Finding rollup</div>
                <div className="flex flex-wrap gap-2">
                  {(['critical', 'high', 'medium', 'low'] as const).map((k) =>
                    num(detailRollup[k]) > 0 ? (
                      <Badge key={k} tone={severityTone(k)}>
                        {num(detailRollup[k])} {k}
                      </Badge>
                    ) : null,
                  )}
                </div>
              </div>
            )}

            {/* Owned pipelines */}
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Owned pipelines</div>
              {detailPipelines.length === 0 ? (
                <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-sm text-zinc-500">
                  No pipelines are assigned to this team.
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Pipeline</TH>
                      <TH>Repo</TH>
                      <TH>Branch</TH>
                      <TH className="text-right">Risk</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {detailPipelines.map((p) => (
                      <TR key={p.id}>
                        <TD className="font-medium text-zinc-100">{p.name}</TD>
                        <TD className="text-zinc-400">{p.repo || '—'}</TD>
                        <TD className="text-zinc-500">{p.branch || '—'}</TD>
                        <TD className="text-right">
                          <span className={`font-semibold ${riskColor(num(p.risk_score))}`}>
                            {num(p.risk_score).toFixed(0)}
                          </span>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>

            {/* Members */}
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Members</div>
              {(detail.member_ids ?? []).length === 0 ? (
                <p className="text-sm text-zinc-500">No members listed.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(detail.member_ids ?? []).map((m) => (
                    <Badge key={m} tone="neutral">
                      {m}
                    </Badge>
                  ))}
                </div>
              )}
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
