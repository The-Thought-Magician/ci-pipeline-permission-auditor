import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  workspaces,
  pipelines,
  pipeline_identities,
  oidc_trusts,
  roles,
  permissions,
  resources,
  pipeline_actions,
  actions,
  effective_permissions,
} from '../db/schema.js'
import { eq, and, desc, inArray } from 'drizzle-orm'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ownWorkspace(workspaceId: string, userId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  if (!ws) return { ok: false as const, status: 404 as const, error: 'Workspace not found' }
  if (ws.owner_id !== userId) return { ok: false as const, status: 403 as const, error: 'Forbidden' }
  return { ok: true as const, workspace: ws }
}

interface ResolvedPerm {
  action: string
  category: string
  resource_id: string | null
  source_chain: string[]
  is_excess: boolean
}

/**
 * Transitive effective-permission resolver for one pipeline.
 *
 * Walks the trust/permission graph and records, for each reachable action, the
 * full source chain that grants it:
 *
 *   pipeline -> identity -> (oidc trust -> assumable role) -> role -> permission
 *   pipeline -> identity -> permission (directly attached)
 *   pipeline -> action -> inherited privilege
 *   pipeline -> declared permission (workflow `permissions:` block)
 *
 * An action is flagged `is_excess` when it is granted transitively (via a role
 * or action) but is NOT present in the pipeline's declared_permissions, i.e.
 * the pipeline can do more than it openly declares.
 */
function resolvePipeline(
  pipeline: typeof pipelines.$inferSelect,
  identities: (typeof pipeline_identities.$inferSelect)[],
  trustsByIdentity: Map<string, (typeof oidc_trusts.$inferSelect)[]>,
  permsByRole: Map<string, (typeof permissions.$inferSelect)[]>,
  permsByIdentity: Map<string, (typeof permissions.$inferSelect)[]>,
  rolesById: Map<string, typeof roles.$inferSelect>,
  actionLinks: (typeof pipeline_actions.$inferSelect)[],
  actionsById: Map<string, typeof actions.$inferSelect>,
): ResolvedPerm[] {
  const declared = new Set<string>(Object.keys(pipeline.declared_permissions ?? {}))
  // De-dupe by action + resource; keep the shortest source chain seen.
  const out = new Map<string, ResolvedPerm>()

  const record = (
    action: string,
    category: string,
    resourceId: string | null,
    chain: string[],
    declaredHere: boolean,
  ) => {
    const key = `${action}::${resourceId ?? ''}`
    const isExcess = !declaredHere && !declared.has(action)
    const existing = out.get(key)
    if (!existing) {
      out.set(key, { action, category, resource_id: resourceId, source_chain: chain, is_excess: isExcess })
      return
    }
    // Prefer the shortest provenance; once declared, never re-mark as excess.
    if (chain.length < existing.source_chain.length) existing.source_chain = chain
    if (!isExcess) existing.is_excess = false
  }

  const pipeLabel = `pipeline:${pipeline.name}`

  // 1. Declared permissions from the workflow file itself.
  for (const [action, level] of Object.entries(pipeline.declared_permissions ?? {})) {
    record(action, 'repo', null, [pipeLabel, `declared:${action}=${String(level)}`], true)
  }

  // 2. Identity-rooted chains.
  for (const id of identities) {
    const idLabel = `identity:${id.name}`

    // 2a. Permissions attached directly to the identity.
    for (const perm of permsByIdentity.get(id.id) ?? []) {
      if (perm.effect === 'deny') continue
      record(perm.action, perm.category, perm.resource_id ?? null, [pipeLabel, idLabel, `permission:${perm.action}`], false)
    }

    // 2b. OIDC trusts -> assumable roles -> role permissions.
    for (const trust of trustsByIdentity.get(id.id) ?? []) {
      const trustLabel = `oidc:${trust.issuer}#${trust.sub_claim_pattern}`
      for (const roleId of trust.assumable_role_ids ?? []) {
        const role = rolesById.get(roleId)
        if (!role) continue
        const roleLabel = `role:${role.name}`
        for (const perm of permsByRole.get(roleId) ?? []) {
          if (perm.effect === 'deny') continue
          record(
            perm.action,
            perm.category,
            perm.resource_id ?? null,
            [pipeLabel, idLabel, trustLabel, roleLabel, `permission:${perm.action}`],
            false,
          )
        }
      }
    }
  }

  // 3. Third-party action inherited privileges.
  for (const link of actionLinks) {
    const action = actionsById.get(link.action_id)
    const actionLabel = `action:${action?.name ?? link.action_id}`
    const privileges =
      (link.inherited_privileges?.length ? link.inherited_privileges : action?.inherited_privileges) ?? []
    for (const priv of privileges) {
      record(priv, 'repo', null, [pipeLabel, actionLabel, `inherited:${priv}`], false)
    }
  }

  return [...out.values()]
}

// ---------------------------------------------------------------------------
// Resolve the full graph for a workspace (optionally a single pipeline) and
// rewrite the effective_permissions rows.
// ---------------------------------------------------------------------------

async function runResolver(workspaceId: string, onlyPipelineId?: string) {
  const wsPipelines = onlyPipelineId
    ? await db.select().from(pipelines).where(and(eq(pipelines.workspace_id, workspaceId), eq(pipelines.id, onlyPipelineId)))
    : await db.select().from(pipelines).where(eq(pipelines.workspace_id, workspaceId))

  if (wsPipelines.length === 0) return { resolved: 0, pipelines: 0 }

  // Load the workspace graph once.
  const wsIdentities = await db
    .select()
    .from(pipeline_identities)
    .where(eq(pipeline_identities.workspace_id, workspaceId))
  const wsTrusts = await db.select().from(oidc_trusts).where(eq(oidc_trusts.workspace_id, workspaceId))
  const wsRoles = await db.select().from(roles).where(eq(roles.workspace_id, workspaceId))
  const wsPerms = await db.select().from(permissions).where(eq(permissions.workspace_id, workspaceId))
  const wsActionLinks = await db
    .select()
    .from(pipeline_actions)
    .where(eq(pipeline_actions.workspace_id, workspaceId))
  const wsActions = await db.select().from(actions).where(eq(actions.workspace_id, workspaceId))

  const identitiesByPipeline = new Map<string, (typeof pipeline_identities.$inferSelect)[]>()
  for (const id of wsIdentities) {
    const arr = identitiesByPipeline.get(id.pipeline_id) ?? []
    arr.push(id)
    identitiesByPipeline.set(id.pipeline_id, arr)
  }
  const trustsByIdentity = new Map<string, (typeof oidc_trusts.$inferSelect)[]>()
  for (const t of wsTrusts) {
    if (!t.identity_id) continue
    const arr = trustsByIdentity.get(t.identity_id) ?? []
    arr.push(t)
    trustsByIdentity.set(t.identity_id, arr)
  }
  const permsByRole = new Map<string, (typeof permissions.$inferSelect)[]>()
  const permsByIdentity = new Map<string, (typeof permissions.$inferSelect)[]>()
  for (const p of wsPerms) {
    if (p.role_id) {
      const arr = permsByRole.get(p.role_id) ?? []
      arr.push(p)
      permsByRole.set(p.role_id, arr)
    }
    if (p.identity_id) {
      const arr = permsByIdentity.get(p.identity_id) ?? []
      arr.push(p)
      permsByIdentity.set(p.identity_id, arr)
    }
  }
  const rolesById = new Map(wsRoles.map((r) => [r.id, r]))
  const actionsById = new Map(wsActions.map((a) => [a.id, a]))
  const actionLinksByPipeline = new Map<string, (typeof pipeline_actions.$inferSelect)[]>()
  for (const l of wsActionLinks) {
    const arr = actionLinksByPipeline.get(l.pipeline_id) ?? []
    arr.push(l)
    actionLinksByPipeline.set(l.pipeline_id, arr)
  }

  let totalResolved = 0
  for (const pipeline of wsPipelines) {
    const resolved = resolvePipeline(
      pipeline,
      identitiesByPipeline.get(pipeline.id) ?? [],
      trustsByIdentity,
      permsByRole,
      permsByIdentity,
      rolesById,
      actionLinksByPipeline.get(pipeline.id) ?? [],
      actionsById,
    )

    // Replace this pipeline's effective rows.
    await db.delete(effective_permissions).where(eq(effective_permissions.pipeline_id, pipeline.id))
    if (resolved.length > 0) {
      const now = new Date()
      await db.insert(effective_permissions).values(
        resolved.map((r) => ({
          workspace_id: workspaceId,
          pipeline_id: pipeline.id,
          action: r.action,
          category: r.category,
          resource_id: r.resource_id,
          source_chain: r.source_chain,
          is_excess: r.is_excess,
          resolved_at: now,
        })),
      )
    }
    totalResolved += resolved.length
  }

  return { resolved: totalResolved, pipelines: wsPipelines.length }
}

// ---------------------------------------------------------------------------
// GET / — list effective permissions (with resource detail)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  const pipelineId = c.req.query('pipeline_id')
  if (!workspaceId && !pipelineId) {
    return c.json({ error: 'workspace_id or pipeline_id is required' }, 400)
  }

  const conds = []
  if (workspaceId) conds.push(eq(effective_permissions.workspace_id, workspaceId))
  if (pipelineId) conds.push(eq(effective_permissions.pipeline_id, pipelineId))

  const rows = await db
    .select()
    .from(effective_permissions)
    .where(conds.length === 1 ? conds[0] : and(...conds))
    .orderBy(desc(effective_permissions.is_excess), desc(effective_permissions.resolved_at))

  const resourceIds = [...new Set(rows.map((r) => r.resource_id).filter((x): x is string => !!x))]
  const resList = resourceIds.length
    ? await db.select().from(resources).where(inArray(resources.id, resourceIds))
    : []
  const resById = new Map(resList.map((r) => [r.id, r]))

  return c.json(
    rows.map((r) => ({
      ...r,
      resource: r.resource_id ? resById.get(r.resource_id) ?? null : null,
    })),
  )
})

// ---------------------------------------------------------------------------
// POST /resolve — run the transitive resolver for a workspace or single pipeline
// ---------------------------------------------------------------------------

const resolveSchema = z.object({
  workspace_id: z.string().min(1),
  pipeline_id: z.string().optional(),
})

router.post('/resolve', authMiddleware, zValidator('json', resolveSchema), async (c) => {
  const userId = getUserId(c)
  const { workspace_id, pipeline_id } = c.req.valid('json')
  const owned = await ownWorkspace(workspace_id, userId)
  if (!owned.ok) return c.json({ error: owned.error }, owned.status)

  if (pipeline_id) {
    const [p] = await db.select().from(pipelines).where(eq(pipelines.id, pipeline_id))
    if (!p) return c.json({ error: 'Pipeline not found' }, 404)
    if (p.workspace_id !== workspace_id) return c.json({ error: 'Pipeline not in workspace' }, 400)
  }

  const result = await runResolver(workspace_id, pipeline_id)
  return c.json(result)
})

export default router
