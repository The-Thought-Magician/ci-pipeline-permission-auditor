import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { db } from './db/index.js'
import { migrate } from './db/migrate.js'
import { plans, workspaces } from './db/schema.js'
import { eq } from 'drizzle-orm'

import workspacesRoutes from './routes/workspaces.js'
import providersRoutes from './routes/providers.js'
import connectionsRoutes from './routes/connections.js'
import pipelinesRoutes from './routes/pipelines.js'
import identitiesRoutes from './routes/identities.js'
import oidcRoutes from './routes/oidc.js'
import rolesRoutes from './routes/roles.js'
import permissionsRoutes from './routes/permissions.js'
import resourcesRoutes from './routes/resources.js'
import actionsRoutes from './routes/actions.js'
import secretsRoutes from './routes/secrets.js'
import effectiveRoutes from './routes/effective.js'
import blastRadiusRoutes from './routes/blast-radius.js'
import attackPathsRoutes from './routes/attack-paths.js'
import findingsRoutes from './routes/findings.js'
import recommendationsRoutes from './routes/recommendations.js'
import policiesRoutes from './routes/policies.js'
import snapshotsRoutes from './routes/snapshots.js'
import driftRoutes from './routes/drift.js'
import auditsRoutes from './routes/audits.js'
import evidenceRoutes from './routes/evidence.js'
import reportsRoutes from './routes/reports.js'
import teamsRoutes from './routes/teams.js'
import alertsRoutes from './routes/alerts.js'
import notificationsRoutes from './routes/notifications.js'
import activityRoutes from './routes/activity.js'
import analyzerRoutes from './routes/analyzer.js'
import statsRoutes from './routes/stats.js'
import billingRoutes from './routes/billing.js'
import seedRoutes from './routes/seed.js'

const app = new Hono()

const allowedOrigins = [
  process.env.FRONTEND_URL ?? 'http://localhost:3000',
  'https://ci-pipeline-permission-auditor.vercel.app',
]

app.use('*', cors({
  origin: (origin) => (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]),
  credentials: true,
}))

const api = new Hono()
api.route('/workspaces', workspacesRoutes)
api.route('/providers', providersRoutes)
api.route('/connections', connectionsRoutes)
api.route('/pipelines', pipelinesRoutes)
api.route('/identities', identitiesRoutes)
api.route('/oidc', oidcRoutes)
api.route('/roles', rolesRoutes)
api.route('/permissions', permissionsRoutes)
api.route('/resources', resourcesRoutes)
api.route('/actions', actionsRoutes)
api.route('/secrets', secretsRoutes)
api.route('/effective', effectiveRoutes)
api.route('/blast-radius', blastRadiusRoutes)
api.route('/attack-paths', attackPathsRoutes)
api.route('/findings', findingsRoutes)
api.route('/recommendations', recommendationsRoutes)
api.route('/policies', policiesRoutes)
api.route('/snapshots', snapshotsRoutes)
api.route('/drift', driftRoutes)
api.route('/audits', auditsRoutes)
api.route('/evidence', evidenceRoutes)
api.route('/reports', reportsRoutes)
api.route('/teams', teamsRoutes)
api.route('/alerts', alertsRoutes)
api.route('/notifications', notificationsRoutes)
api.route('/activity', activityRoutes)
api.route('/analyzer', analyzerRoutes)
api.route('/stats', statsRoutes)
api.route('/billing', billingRoutes)
api.route('/seed', seedRoutes)

app.route('/api/v1', api)
app.get('/health', (c) => c.json({ ok: true }))

/**
 * Idempotent seed: seed the two billing plans if the table is empty.
 * Count-then-insert so it is safe to run on every boot.
 */
async function seedIfEmpty() {
  const existing = await db.select().from(plans).limit(1)
  if (existing.length === 0) {
    await db.insert(plans).values([
      { id: 'free', name: 'Free', price_cents: 0 },
      { id: 'pro', name: 'Pro', price_cents: 2900 },
    ]).onConflictDoNothing()
    console.log('Seeded plans')
  }

  // Demo workspace so the app is never empty on first boot.
  const demoOwner = 'demo-user'
  const demoSlug = 'demo-workspace'
  const existingWs = await db.select().from(workspaces).where(eq(workspaces.slug, demoSlug)).limit(1)
  if (existingWs.length === 0) {
    await db.insert(workspaces).values({
      name: 'Demo Workspace',
      slug: demoSlug,
      owner_id: demoOwner,
      description: 'Sample workspace seeded at first boot',
    }).onConflictDoNothing()
    console.log('Seeded demo workspace')
  }
}

const port = parseInt(process.env.PORT ?? '3001')

// CRITICAL boot order: bind the port FIRST so the platform health check sees a
// live service immediately. Run migrate() and seedIfEmpty() AFTER serve(), each
// in its own try/catch — a cold DB connection must never block port binding.
serve({ fetch: app.fetch, port }, () => console.log(`Server running on port ${port}`))

;(async () => {
  try {
    await migrate()
    console.log('Migrations applied')
  } catch (e) {
    console.error('Migration error:', e)
  }
  try {
    await seedIfEmpty()
  } catch (e) {
    console.error('Seed error:', e)
  }
})()

export default app
