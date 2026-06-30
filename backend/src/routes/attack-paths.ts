import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  workspaces,
  pipelines,
  pipeline_identities,
  oidc_trusts,
  roles,
  permissions,
  resources,
  secrets,
  secret_references,
  attack_paths,
} from '../db/schema.js'
import { authMiddleware, getUserId } from '../lib/auth.js'

const router = new Hono()

async function ownsWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  if (!workspaceId || !userId) return false
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  return !!ws && ws.owner_id === userId
}

interface GraphNode {
  id: string
  kind: string
  label: string
}

/**
 * Build the directed attack-path edge set for one pipeline by walking:
 *   pipeline --triggers--> identity
 *   identity --assumes--> role        (via OIDC trust assumable_role_ids)
 *   role     --writes/reads--> resource (via permissions)
 *   pipeline --reads--> secret         (via secret_references)
 * Returns the edge rows ready for insertion (workspace_id/pipeline_id added by caller).
 */
async function buildEdgesForPipeline(
  pipeline: typeof pipelines.$inferSelect,
): Promise<Array<Omit<typeof attack_paths.$inferInsert, 'workspace_id' | 'pipeline_id'>>> {
  const wsId = pipeline.workspace_id
  const edges: Array<Omit<typeof attack_paths.$inferInsert, 'workspace_id' | 'pipeline_id'>> = []

  const idents = await db
    .select()
    .from(pipeline_identities)
    .where(eq(pipeline_identities.pipeline_id, pipeline.id))

  // Workspace-level lookups (reused across identities).
  const wsRoles = await db.select().from(roles).where(eq(roles.workspace_id, wsId))
  const roleMap = new Map(wsRoles.map((r) => [r.id, r]))
  const wsResources = await db.select().from(resources).where(eq(resources.workspace_id, wsId))
  const resourceMap = new Map(wsResources.map((r) => [r.id, r]))
  const wsPerms = await db.select().from(permissions).where(eq(permissions.workspace_id, wsId))

  for (const ident of idents) {
    // pipeline -> identity
    edges.push({
      from_node: pipeline.id,
      from_kind: 'pipeline',
      to_node: ident.id,
      to_kind: 'identity',
      edge_type: 'triggers',
      weight: 1,
    })

    // identity -> role  (OIDC assumable roles + direct identity permissions' roles)
    const trusts = await db
      .select()
      .from(oidc_trusts)
      .where(eq(oidc_trusts.identity_id, ident.id))
    const assumableRoleIds = new Set<string>()
    for (const t of trusts) {
      for (const rid of t.assumable_role_ids ?? []) assumableRoleIds.add(rid)
    }
    for (const rid of assumableRoleIds) {
      const role = roleMap.get(rid)
      if (!role) continue
      edges.push({
        from_node: ident.id,
        from_kind: 'identity',
        to_node: role.id,
        to_kind: 'role',
        edge_type: 'assumes',
        weight: role.is_privileged ? 3 : 1,
      })
      // role -> resource (via permissions attached to the role)
      for (const perm of wsPerms) {
        if (perm.role_id !== role.id || !perm.resource_id) continue
        const res = resourceMap.get(perm.resource_id)
        if (!res) continue
        edges.push({
          from_node: role.id,
          from_kind: 'role',
          to_node: res.id,
          to_kind: 'resource',
          edge_type: perm.effect === 'deny' ? 'reads' : perm.action.toLowerCase().includes('write') || perm.action.toLowerCase().includes('put') || perm.action.toLowerCase().includes('delete') ? 'writes' : 'reads',
          weight: res.is_crown_jewel ? 5 : perm.is_wildcard ? 3 : 1,
        })
      }
    }

    // identity -> resource (permissions attached directly to the identity)
    for (const perm of wsPerms) {
      if (perm.identity_id !== ident.id || !perm.resource_id) continue
      const res = resourceMap.get(perm.resource_id)
      if (!res) continue
      edges.push({
        from_node: ident.id,
        from_kind: 'identity',
        to_node: res.id,
        to_kind: 'resource',
        edge_type:
          perm.action.toLowerCase().includes('write') ||
          perm.action.toLowerCase().includes('put') ||
          perm.action.toLowerCase().includes('delete')
            ? 'writes'
            : 'reads',
        weight: res.is_crown_jewel ? 5 : perm.is_wildcard ? 3 : 1,
      })
    }
  }

  // pipeline -> secret (secret references)
  const secRefs = await db
    .select()
    .from(secret_references)
    .where(eq(secret_references.pipeline_id, pipeline.id))
  for (const ref of secRefs) {
    edges.push({
      from_node: pipeline.id,
      from_kind: 'pipeline',
      to_node: ref.secret_id,
      to_kind: 'secret',
      edge_type: 'reads',
      weight: ref.is_logged ? 4 : 2,
    })
  }

  return edges
}

/** Derive node objects from a set of edge rows, labelling against the workspace inventory. */
async function nodesFromEdges(
  workspaceId: string,
  edges: Array<typeof attack_paths.$inferSelect>,
): Promise<GraphNode[]> {
  const ids = new Map<string, string>() // id -> kind
  for (const e of edges) {
    if (!ids.has(e.from_node)) ids.set(e.from_node, e.from_kind)
    if (!ids.has(e.to_node)) ids.set(e.to_node, e.to_kind)
  }

  // Pull labels from each inventory table once.
  const [ps, idents, rs, res, secs] = await Promise.all([
    db.select().from(pipelines).where(eq(pipelines.workspace_id, workspaceId)),
    db.select().from(pipeline_identities).where(eq(pipeline_identities.workspace_id, workspaceId)),
    db.select().from(roles).where(eq(roles.workspace_id, workspaceId)),
    db.select().from(resources).where(eq(resources.workspace_id, workspaceId)),
    db.select().from(secrets).where(eq(secrets.workspace_id, workspaceId)),
  ])
  const labelMap = new Map<string, string>()
  for (const p of ps) labelMap.set(p.id, p.name)
  for (const i of idents) labelMap.set(i.id, i.name)
  for (const r of rs) labelMap.set(r.id, r.name)
  for (const r of res) labelMap.set(r.id, r.name)
  for (const s of secs) labelMap.set(s.id, s.name)

  const nodes: GraphNode[] = []
  for (const [id, kind] of ids) {
    nodes.push({ id, kind, label: labelMap.get(id) ?? id })
  }
  return nodes
}

// ---------------------------------------------------------------------------
// GET / — attack-path graph (nodes + edges)
// ---------------------------------------------------------------------------

router.get('/', async (c) => {
  const workspaceId = c.req.query('workspace_id')
  if (!workspaceId) return c.json({ error: 'workspace_id is required' }, 400)
  const pipelineId = c.req.query('pipeline_id')

  const edges = await db
    .select()
    .from(attack_paths)
    .where(
      pipelineId
        ? and(eq(attack_paths.workspace_id, workspaceId), eq(attack_paths.pipeline_id, pipelineId))
        : eq(attack_paths.workspace_id, workspaceId),
    )

  const nodes = await nodesFromEdges(workspaceId, edges)
  return c.json({ nodes, edges })
})

// ---------------------------------------------------------------------------
// POST /rebuild — rebuild the attack-path graph for a workspace/pipeline
// ---------------------------------------------------------------------------

const rebuildSchema = z.object({
  workspace_id: z.string().min(1),
  pipeline_id: z.string().optional(),
})

router.post('/rebuild', authMiddleware, zValidator('json', rebuildSchema), async (c) => {
  const userId = getUserId(c)
  const { workspace_id, pipeline_id } = c.req.valid('json')
  if (!(await ownsWorkspace(workspace_id, userId))) return c.json({ error: 'Forbidden' }, 403)

  let targets: (typeof pipelines.$inferSelect)[]
  if (pipeline_id) {
    const [p] = await db.select().from(pipelines).where(eq(pipelines.id, pipeline_id))
    if (!p) return c.json({ error: 'Pipeline not found' }, 404)
    if (p.workspace_id !== workspace_id) return c.json({ error: 'Forbidden' }, 403)
    targets = [p]
  } else {
    targets = await db.select().from(pipelines).where(eq(pipelines.workspace_id, workspace_id))
  }

  let edgeCount = 0
  for (const p of targets) {
    // Clear prior edges for this pipeline, then re-derive.
    await db.delete(attack_paths).where(eq(attack_paths.pipeline_id, p.id))
    const edges = await buildEdgesForPipeline(p)
    for (const e of edges) {
      await db.insert(attack_paths).values({ ...e, workspace_id, pipeline_id: p.id })
      edgeCount++
    }
  }

  return c.json({ edges: edgeCount })
})

export default router
