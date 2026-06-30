// src/lib/cron.ts — THE ENGINE.
//
// Pure, deterministic, self-contained schedule analysis functions. No DB, no
// network, no external services. Routes import these helpers to validate and
// reason about CI pipeline schedules (cron / rate / one-off triggers).
//
// Schedule "kinds":
//   - 'cron'   : a standard 5-or-6-field cron expression, parsed via cron-parser.
//   - 'rate'   : a human "every N minutes|hours|days" string, computed arithmetically.
//   - 'oneoff' : a single ISO-8601 instant; fires once if it is in the future.

import { CronExpressionParser } from 'cron-parser'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScheduleKind = 'cron' | 'rate' | 'oneoff'

export interface ValidationResult {
  valid: boolean
  error?: string
}

export interface ScheduleJob {
  /** Stable identifier for the job (used in collision/coverage output). */
  id: string
  kind: ScheduleKind
  expr: string
  /** IANA timezone, e.g. "UTC", "America/New_York". Defaults to UTC. */
  timezone?: string
  /** Optional resource this job touches; used for resource-collision detection. */
  resourceId?: string
}

export interface CollisionWindow {
  windowStart: string
  windowEnd: string
  jobIds: string[]
  severity: 'low' | 'medium' | 'high'
  resourceId?: string
}

export interface HeatmapBucket {
  bucket: string
  count: number
}

export type DstTrapType = 'double_fire' | 'skip' | 'ambiguous'

export interface DstTrap {
  type: DstTrapType
  atLocal: string
  atUtc: string
}

export interface CoverageWindow {
  /** Cron/rate/oneoff schedule describing when coverage is REQUIRED. */
  kind: ScheduleKind
  expr: string
  timezone?: string
  /** Minutes of slack after a required firing during which a job satisfies it. */
  graceMinutes?: number
  label?: string
}

export interface CoverageGap {
  windowStart: string
  windowEnd: string
  expected: string
  label?: string
}

export interface SpreadSuggestion {
  jobId: string
  suggestedExpr: string
  reason: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const RATE_RE = /^\s*every\s+(\d+)\s+(minute|minutes|hour|hours|day|days)\s*$/i

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

interface ParsedRate {
  count: number
  unit: 'minute' | 'hour' | 'day'
  intervalMs: number
}

function parseRate(expr: string): ParsedRate | null {
  const m = RATE_RE.exec(expr)
  if (!m) return null
  const count = parseInt(m[1], 10)
  if (!Number.isFinite(count) || count <= 0) return null
  const rawUnit = m[2].toLowerCase()
  const unit: ParsedRate['unit'] = rawUnit.startsWith('minute')
    ? 'minute'
    : rawUnit.startsWith('hour')
      ? 'hour'
      : 'day'
  const intervalMs =
    unit === 'minute' ? count * MS_PER_MINUTE : unit === 'hour' ? count * MS_PER_HOUR : count * MS_PER_DAY
  return { count, unit, intervalMs }
}

function safeTz(timezone?: string): string {
  return timezone && timezone.trim().length > 0 ? timezone : 'UTC'
}

/** Truncate an ISO instant to whole-minute resolution (UTC). */
function minuteKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16) + ':00.000Z'
}

/**
 * Timezone offset (in minutes) that the given IANA timezone has at a given
 * UTC instant. Positive = ahead of UTC. Computed purely via Intl, no deps.
 */
function tzOffsetMinutes(date: Date, timezone: string): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const parts = dtf.formatToParts(date)
    const map: Record<string, string> = {}
    for (const p of parts) map[p.type] = p.value
    const asUTC = Date.UTC(
      parseInt(map.year, 10),
      parseInt(map.month, 10) - 1,
      parseInt(map.day, 10),
      parseInt(map.hour === '24' ? '0' : map.hour, 10),
      parseInt(map.minute, 10),
      parseInt(map.second, 10),
    )
    return Math.round((asUTC - date.getTime()) / MS_PER_MINUTE)
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// validateExpression
// ---------------------------------------------------------------------------

export function validateExpression(kind: ScheduleKind, expr: string): ValidationResult {
  if (typeof expr !== 'string' || expr.trim().length === 0) {
    return { valid: false, error: 'Expression is empty' }
  }
  if (kind === 'cron') {
    try {
      CronExpressionParser.parse(expr)
      return { valid: true }
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  if (kind === 'rate') {
    const r = parseRate(expr)
    if (!r) return { valid: false, error: 'Rate must look like "every N minutes|hours|days"' }
    return { valid: true }
  }
  if (kind === 'oneoff') {
    const t = Date.parse(expr)
    if (Number.isNaN(t)) return { valid: false, error: 'One-off must be a valid ISO-8601 instant' }
    return { valid: true }
  }
  return { valid: false, error: `Unknown schedule kind: ${String(kind)}` }
}

// ---------------------------------------------------------------------------
// describeExpression
// ---------------------------------------------------------------------------

export function describeExpression(kind: ScheduleKind, expr: string, timezone?: string): string {
  const tz = safeTz(timezone)
  const v = validateExpression(kind, expr)
  if (!v.valid) return `Invalid ${kind} expression: ${v.error ?? 'unknown error'}`

  if (kind === 'rate') {
    const r = parseRate(expr)!
    const plural = r.count === 1 ? r.unit : `${r.unit}s`
    return `Runs every ${r.count} ${plural} (${tz})`
  }
  if (kind === 'oneoff') {
    return `Runs once at ${new Date(expr).toISOString()} (${tz})`
  }
  // cron
  const fields = expr.trim().split(/\s+/)
  const [min, hour, dom, mon, dow] = fields
  const parts: string[] = []
  if (min === '*' && hour === '*') {
    parts.push('every minute')
  } else if (/^\*\/\d+$/.test(min) && hour === '*') {
    parts.push(`every ${min.slice(2)} minutes`)
  } else if (min !== '*' && hour !== '*') {
    parts.push(`at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`)
  } else if (hour !== '*') {
    parts.push(`during hour ${hour}`)
  } else {
    parts.push(`at minute ${min}`)
  }
  if (dom !== '*') parts.push(`on day-of-month ${dom}`)
  if (mon !== '*') parts.push(`in month ${mon}`)
  if (dow !== '*') parts.push(`on weekday ${dow}`)
  return `Cron "${expr}": ${parts.join(', ')} (${tz})`
}

// ---------------------------------------------------------------------------
// nextFirings
// ---------------------------------------------------------------------------

export function nextFirings(
  kind: ScheduleKind,
  expr: string,
  timezone: string | undefined,
  fromISO: string,
  count: number,
): string[] {
  const tz = safeTz(timezone)
  const n = Math.max(0, Math.floor(count))
  if (n === 0) return []
  const fromTime = Date.parse(fromISO)
  const from = Number.isNaN(fromTime) ? new Date() : new Date(fromTime)

  if (kind === 'cron') {
    try {
      const interval = CronExpressionParser.parse(expr, { tz, currentDate: from })
      const out: string[] = []
      for (let i = 0; i < n; i++) {
        const next = interval.next()
        out.push(new Date(next.getTime()).toISOString())
      }
      return out
    } catch {
      return []
    }
  }

  if (kind === 'rate') {
    const r = parseRate(expr)
    if (!r) return []
    const out: string[] = []
    let t = from.getTime() + r.intervalMs
    for (let i = 0; i < n; i++) {
      out.push(new Date(t).toISOString())
      t += r.intervalMs
    }
    return out
  }

  if (kind === 'oneoff') {
    const t = Date.parse(expr)
    if (Number.isNaN(t)) return []
    if (t > from.getTime()) return [new Date(t).toISOString()]
    return []
  }

  return []
}

/** All firings of a job within [from, from + horizonDays]. Internal helper. */
function firingsInHorizon(job: ScheduleJob, fromISO: string, horizonDays: number): string[] {
  const from = new Date(Number.isNaN(Date.parse(fromISO)) ? Date.now() : Date.parse(fromISO))
  const end = from.getTime() + horizonDays * MS_PER_DAY
  const tz = safeTz(job.timezone)

  if (job.kind === 'cron') {
    try {
      const interval = CronExpressionParser.parse(job.expr, { tz, currentDate: from })
      const out: string[] = []
      // Hard cap to avoid pathological "* * * * *" blowups over long horizons.
      const cap = 100_000
      for (let i = 0; i < cap; i++) {
        const next = interval.next().getTime()
        if (next > end) break
        out.push(new Date(next).toISOString())
      }
      return out
    } catch {
      return []
    }
  }

  if (job.kind === 'rate') {
    const r = parseRate(job.expr)
    if (!r) return []
    const out: string[] = []
    let t = from.getTime() + r.intervalMs
    const cap = 100_000
    let i = 0
    while (t <= end && i < cap) {
      out.push(new Date(t).toISOString())
      t += r.intervalMs
      i++
    }
    return out
  }

  if (job.kind === 'oneoff') {
    const t = Date.parse(job.expr)
    if (Number.isNaN(t)) return []
    if (t > from.getTime() && t <= end) return [new Date(t).toISOString()]
    return []
  }

  return []
}

// ---------------------------------------------------------------------------
// computeCollisions
// ---------------------------------------------------------------------------

export function computeCollisions(
  jobs: ScheduleJob[],
  opts: { horizonDays?: number; threshold?: number; fromISO?: string } = {},
): CollisionWindow[] {
  const horizonDays = opts.horizonDays ?? 7
  const threshold = Math.max(2, opts.threshold ?? 2)
  const fromISO = opts.fromISO ?? new Date().toISOString()

  // Bucket all firings by whole minute.
  const byMinute = new Map<string, { jobIds: Set<string>; resources: Map<string, Set<string>> }>()

  for (const job of jobs) {
    const firings = firingsInHorizon(job, fromISO, horizonDays)
    for (const f of firings) {
      const key = minuteKey(f)
      let entry = byMinute.get(key)
      if (!entry) {
        entry = { jobIds: new Set(), resources: new Map() }
        byMinute.set(key, entry)
      }
      entry.jobIds.add(job.id)
      if (job.resourceId) {
        let rs = entry.resources.get(job.resourceId)
        if (!rs) {
          rs = new Set()
          entry.resources.set(job.resourceId, rs)
        }
        rs.add(job.id)
      }
    }
  }

  const out: CollisionWindow[] = []
  for (const [key, entry] of byMinute) {
    const jobIds = [...entry.jobIds]
    const concurrency = jobIds.length

    // Resource contention: >=2 distinct jobs sharing one resource in this minute.
    let contendedResource: string | undefined
    for (const [resId, jset] of entry.resources) {
      if (jset.size >= 2) {
        contendedResource = resId
        break
      }
    }

    const concurrencyHit = concurrency >= threshold
    if (!concurrencyHit && !contendedResource) continue

    const start = new Date(key)
    const end = new Date(start.getTime() + MS_PER_MINUTE)

    let severity: CollisionWindow['severity'] = 'low'
    if (contendedResource) severity = 'high'
    else if (concurrency >= threshold + 2) severity = 'high'
    else if (concurrency >= threshold + 1) severity = 'medium'
    else severity = 'low'

    out.push({
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      jobIds,
      severity,
      ...(contendedResource ? { resourceId: contendedResource } : {}),
    })
  }

  out.sort((a, b) => a.windowStart.localeCompare(b.windowStart))
  return out
}

// ---------------------------------------------------------------------------
// loadHeatmap
// ---------------------------------------------------------------------------

export function loadHeatmap(
  jobs: ScheduleJob[],
  opts: { horizonDays?: number; fromISO?: string } = {},
): HeatmapBucket[] {
  const horizonDays = opts.horizonDays ?? 7
  const fromISO = opts.fromISO ?? new Date().toISOString()

  // Bucket per hour for a readable load distribution.
  const byHour = new Map<string, number>()
  for (const job of jobs) {
    for (const f of firingsInHorizon(job, fromISO, horizonDays)) {
      const hourKey = new Date(f).toISOString().slice(0, 13) + ':00:00.000Z'
      byHour.set(hourKey, (byHour.get(hourKey) ?? 0) + 1)
    }
  }
  const out: HeatmapBucket[] = [...byHour.entries()].map(([bucket, count]) => ({ bucket, count }))
  out.sort((a, b) => a.bucket.localeCompare(b.bucket))
  return out
}

// ---------------------------------------------------------------------------
// dstTraps
// ---------------------------------------------------------------------------

export function dstTraps(
  kind: ScheduleKind,
  expr: string,
  timezone: string | undefined,
  fromISO: string,
  days: number,
): DstTrap[] {
  const tz = safeTz(timezone)
  if (tz === 'UTC') return [] // UTC never shifts.
  const from = new Date(Number.isNaN(Date.parse(fromISO)) ? Date.now() : Date.parse(fromISO))
  const horizonDays = Math.max(0, Math.floor(days))
  const end = from.getTime() + horizonDays * MS_PER_DAY

  // Find all UTC instants in the window where the timezone offset changes,
  // scanning at hourly resolution then narrowing to the minute.
  const traps: DstTrap[] = []
  let prevOffset = tzOffsetMinutes(from, tz)
  for (let t = from.getTime() + MS_PER_HOUR; t <= end; t += MS_PER_HOUR) {
    const cur = tzOffsetMinutes(new Date(t), tz)
    if (cur === prevOffset) continue

    // Narrow the transition down to the minute it occurs.
    let lo = t - MS_PER_HOUR
    let hi = t
    while (hi - lo > MS_PER_MINUTE) {
      const mid = lo + Math.floor((hi - lo) / 2 / MS_PER_MINUTE) * MS_PER_MINUTE
      if (mid <= lo) break
      if (tzOffsetMinutes(new Date(mid), tz) === prevOffset) lo = mid
      else hi = mid
    }
    const transitionUtc = new Date(hi)
    const forward = cur > prevOffset // clocks spring forward -> a local hour is skipped
    const type: DstTrapType = forward ? 'skip' : 'double_fire'

    // Local wall-clock time just before the transition (in the tz).
    const localBefore = new Date(transitionUtc.getTime() + prevOffset * MS_PER_MINUTE)
      .toISOString()
      .replace('Z', '')

    // Does the schedule actually fire near this transition window? If so it is
    // an active trap; otherwise still report it as 'ambiguous' for awareness.
    const window: ScheduleJob = { id: '_dst', kind, expr, timezone: tz }
    const probeFrom = new Date(transitionUtc.getTime() - MS_PER_HOUR).toISOString()
    const fired = firingsInHorizon(window, probeFrom, 1 / 12) // ~2h probe window
    const firesInGap = fired.some((f) => {
      const ft = Date.parse(f)
      return ft >= transitionUtc.getTime() - MS_PER_HOUR && ft <= transitionUtc.getTime() + MS_PER_HOUR
    })

    traps.push({
      type: firesInGap ? type : 'ambiguous',
      atLocal: localBefore,
      atUtc: transitionUtc.toISOString(),
    })

    prevOffset = cur
  }

  return traps
}

// ---------------------------------------------------------------------------
// coverageGaps
// ---------------------------------------------------------------------------

export function coverageGaps(
  windows: CoverageWindow[],
  jobs: ScheduleJob[],
  opts: { horizonDays?: number; fromISO?: string } = {},
): CoverageGap[] {
  const horizonDays = opts.horizonDays ?? 7
  const fromISO = opts.fromISO ?? new Date().toISOString()
  const from = new Date(Number.isNaN(Date.parse(fromISO)) ? Date.now() : Date.parse(fromISO))

  // All actual job firings in the horizon (sorted ascending).
  const jobFirings: number[] = []
  for (const job of jobs) {
    for (const f of firingsInHorizon(job, fromISO, horizonDays)) jobFirings.push(Date.parse(f))
  }
  jobFirings.sort((a, b) => a - b)

  const gaps: CoverageGap[] = []
  for (const w of windows) {
    const grace = (w.graceMinutes ?? 60) * MS_PER_MINUTE
    const required = firingsInHorizon(
      { id: '_req', kind: w.kind, expr: w.expr, timezone: w.timezone },
      fromISO,
      horizonDays,
    )
    for (const reqIso of required) {
      const reqT = Date.parse(reqIso)
      if (reqT < from.getTime()) continue
      // Covered if any job fires within [reqT - grace, reqT + grace].
      const covered = jobFirings.some((jt) => jt >= reqT - grace && jt <= reqT + grace)
      if (!covered) {
        gaps.push({
          windowStart: new Date(reqT - grace).toISOString(),
          windowEnd: new Date(reqT + grace).toISOString(),
          expected: reqIso,
          ...(w.label ? { label: w.label } : {}),
        })
      }
    }
  }

  gaps.sort((a, b) => a.expected.localeCompare(b.expected))
  return gaps
}

// ---------------------------------------------------------------------------
// autoSpread
// ---------------------------------------------------------------------------

/**
 * Suggest staggered schedules for jobs that collide. Deterministic: jobs are
 * sorted by id; the first job in each colliding minute keeps its slot, the
 * rest get an offset cron expression (or rate kept as-is with a note).
 */
export function autoSpread(
  jobs: ScheduleJob[],
  opts: { threshold?: number; horizonDays?: number; fromISO?: string } = {},
): SpreadSuggestion[] {
  const threshold = Math.max(2, opts.threshold ?? 2)
  const collisions = computeCollisions(jobs, {
    threshold,
    horizonDays: opts.horizonDays ?? 7,
    fromISO: opts.fromISO,
  })

  const byId = new Map<string, ScheduleJob>()
  for (const j of jobs) byId.set(j.id, j)

  const suggested = new Map<string, SpreadSuggestion>()

  for (const col of collisions) {
    const ids = [...col.jobIds].sort()
    // Keep the first; spread the rest by N minutes each.
    ids.slice(1).forEach((id, idx) => {
      if (suggested.has(id)) return
      const job = byId.get(id)
      if (!job) return
      const offsetMin = (idx + 1) * 7 // 7-minute deterministic stagger
      if (job.kind === 'cron') {
        const fields = job.expr.trim().split(/\s+/)
        if (fields.length >= 5) {
          const baseMin = fields[0] === '*' || fields[0].includes('/') ? 0 : parseInt(fields[0], 10) || 0
          fields[0] = String((baseMin + offsetMin) % 60)
          suggested.set(id, {
            jobId: id,
            suggestedExpr: fields.join(' '),
            reason: `Collides with ${ids.length - 1} other job(s) at ${col.windowStart}; staggered by ${offsetMin} min`,
          })
          return
        }
      }
      suggested.set(id, {
        jobId: id,
        suggestedExpr: job.expr,
        reason: `Collides at ${col.windowStart}; consider offsetting start by ${offsetMin} min to reduce concurrency`,
      })
    })
  }

  return [...suggested.values()].sort((a, b) => a.jobId.localeCompare(b.jobId))
}
