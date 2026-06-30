import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  drift_events,
  snapshots,
  workspaces,
  pipelines,
} from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ownsWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  return !!ws && ws.owner_id === userId
}

type PostureMap = Record<string, unknown>

/**
 * A snapshot's `posture` is an opaque jsonb blob. For drift detection we read a
 * per-pipeline permission map out of it. We tolerate a few shapes so detection
 * works against whatever the snapshot writer stored:
 *   posture.pipelines: { [pipelineId]: { name, permissions, identities, actions, trusts } }
 * Falls back to an empty record when absent.
 */
function pipelinesFromPosture(posture: unknown): Record<string, PostureMap> {
  if (!posture || typeof posture !== 'object') return {}
  const p = posture as Record<string, unknown>
  const byPipeline = p.pipelines
  if (byPipeline && typeof byPipeline === 'object') {
    return byPipeline as Record<string, PostureMap>
  }
  return {}
}

function asStringSet(v: unknown): Set<string> {
  const out = new Set<string>()
  if (Array.isArray(v)) {
    for (const item of v) out.add(typeof item === 'string' ? item : JSON.stringify(item))
  } else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out.add(`${k}:${typeof val === 'string' ? val : JSON.stringify(val)}`)
    }
  }
  return out
}

interface DiffRow {
  pipeline_id: string | null
  change_type: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  severity: string
}

/**
 * Compute drift between two posture maps. Emits rows per changed facet
 * (permissions / identities / actions / trusts) per pipeline.
 */
function diffPostures(
  from: Record<string, PostureMap>,
  to: Record<string, PostureMap>,
): DiffRow[] {
  const rows: DiffRow[] = []
  const pipelineIds = new Set<string>([...Object.keys(from), ...Object.keys(to)])

  for (const pid of pipelineIds) {
    const before = from[pid]
    const after = to[pid]

    // Whole-pipeline add / remove.
    if (!before && after) {
      rows.push({
        pipeline_id: pid,
        change_type: 'identity_added',
        before: {},
        after: { pipeline: after },
        severity: 'medium',
      })
      continue
    }
    if (before && !after) {
      rows.push({
        pipeline_id: pid,
        change_type: 'permission_removed',
        before: { pipeline: before },
        after: {},
        severity: 'low',
      })
      continue
    }
    if (!before || !after) continue

    // Permissions facet.
    const beforePerms = asStringSet((before as PostureMap).permissions)
    const afterPerms = asStringSet((after as PostureMap).permissions)
    const addedPerms = [...afterPerms].filter((x) => !beforePerms.has(x))
    const removedPerms = [...beforePerms].filter((x) => !afterPerms.has(x))
    if (addedPerms.length > 0) {
      rows.push({
        pipeline_id: pid,
        change_type: 'permission_added',
        before: { permissions: [...beforePerms] },
        after: { permissions: [...afterPerms], added: addedPerms },
        // Adding write/admin-looking perms is more dangerous.
        severity: addedPerms.some((p) => /write|admin|\*|all/i.test(p)) ? 'high' : 'medium',
      })
    }
    if (removedPerms.length > 0) {
      rows.push({
        pipeline_id: pid,
        change_type: 'permission_removed',
        before: { permissions: [...beforePerms], removed: removedPerms },
        after: { permissions: [...afterPerms] },
        severity: 'low',
      })
    }

    // Identities facet.
    const beforeIds = asStringSet((before as PostureMap).identities)
    const afterIds = asStringSet((after as PostureMap).identities)
    const addedIds = [...afterIds].filter((x) => !beforeIds.has(x))
    if (addedIds.length > 0) {
      rows.push({
        pipeline_id: pid,
        change_type: 'identity_added',
        before: { identities: [...beforeIds] },
        after: { identities: [...afterIds], added: addedIds },
        severity: 'medium',
      })
    }

    // Actions facet.
    const beforeActions = asStringSet((before as PostureMap).actions)
    const afterActions = asStringSet((after as PostureMap).actions)
    const addedActions = [...afterActions].filter((x) => !beforeActions.has(x))
    if (addedActions.length > 0) {
      rows.push({
        pipeline_id: pid,
        change_type: 'action_added',
        before: { actions: [...beforeActions] },
        after: { actions: [...afterActions], added: addedActions },
        severity: 'medium',
      })
    }

    // OIDC trusts facet.
    const beforeTrusts = asStringSet((before as PostureMap).trusts)
    const afterTrusts = asStringSet((after as PostureMap).trusts)
    const trustChanged =
      beforeTrusts.size !== afterTrusts.size ||
      [...afterTrusts].some((x) => !beforeTrusts.has(x))
    if (trustChanged) {
      rows.push({
        pipeline_id: pid,
        change_type: 'trust_changed',
        before: { trusts: [...beforeTrusts] },
        after: { trusts: [...afterTrusts] },
        severity: 'high',
      })
    }
  }

  return rows
}

// ---------------------------------------------------------------------------
// GET / — list drift events (public)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const pipelineId = c.req.query('pipeline_id')

  const conds = []
  if (workspaceId) conds.push(eq(drift_events.workspace_id, workspaceId))
  if (pipelineId) conds.push(eq(drift_events.pipeline_id, pipelineId))

  const rows = await db
    .select()
    .from(drift_events)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(drift_events.created_at))

  return c.json(rows)
})

// ---------------------------------------------------------------------------
// POST /detect — diff two snapshots (auth + owner)
// ---------------------------------------------------------------------------

const detectSchema = z.object({
  workspace_id: z.string().min(1),
  from_snapshot_id: z.string().min(1),
  to_snapshot_id: z.string().min(1),
})

router.post('/detect', authMiddleware, zValidator('json', detectSchema), async (c) => {
  const userId = getUserId(c)
  const { workspace_id, from_snapshot_id, to_snapshot_id } = c.req.valid('json')

  if (!(await ownsWorkspace(workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const [fromSnap] = await db.select().from(snapshots).where(eq(snapshots.id, from_snapshot_id))
  const [toSnap] = await db.select().from(snapshots).where(eq(snapshots.id, to_snapshot_id))
  if (!fromSnap || !toSnap) return c.json({ error: 'Snapshot not found' }, 404)
  if (fromSnap.workspace_id !== workspace_id || toSnap.workspace_id !== workspace_id) {
    return c.json({ error: 'Snapshot belongs to another workspace' }, 400)
  }

  const fromMap = pipelinesFromPosture(fromSnap.posture)
  const toMap = pipelinesFromPosture(toSnap.posture)
  const diffs = diffPostures(fromMap, toMap)

  // Only emit drift for pipelines that still exist (FK is nullable so we null it
  // out for vanished pipelines rather than violating the constraint).
  const existing = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(eq(pipelines.workspace_id, workspace_id))
  const liveIds = new Set(existing.map((p) => p.id))

  const inserted = []
  for (const d of diffs) {
    const pid = d.pipeline_id && liveIds.has(d.pipeline_id) ? d.pipeline_id : null
    const [row] = await db
      .insert(drift_events)
      .values({
        workspace_id,
        pipeline_id: pid,
        from_snapshot_id,
        to_snapshot_id,
        change_type: d.change_type,
        before: d.before,
        after: d.after,
        severity: d.severity,
        status: 'open',
      })
      .returning()
    inserted.push(row)
  }

  return c.json({ events: inserted.length, drift_events: inserted })
})

// ---------------------------------------------------------------------------
// PUT /:id — approve / reject a drift event (auth + owner)
// ---------------------------------------------------------------------------

const decisionSchema = z.object({
  status: z.enum(['open', 'approved', 'rejected']),
})

router.put('/:id', authMiddleware, zValidator('json', decisionSchema), async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const { status } = c.req.valid('json')

  const [existing] = await db.select().from(drift_events).where(eq(drift_events.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (!(await ownsWorkspace(existing.workspace_id, userId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const [updated] = await db
    .update(drift_events)
    .set({ status })
    .where(eq(drift_events.id, id))
    .returning()

  return c.json(updated)
})

export default router
