# CiPipelinePermissionAuditor

Audit what your CI/CD pipelines and build bots can actually do, and surface the over-privileged automation that turns one poisoned workflow into a full breach.

CiPipelinePermissionAuditor (CPPA) is a continuous least-privilege audit platform scoped to CI/CD machine identities and the pipeline-poisoning attack class. It ingests pipeline definitions (GitHub Actions workflows, GitLab CI files, Jenkinsfiles), the OIDC trust and token configuration that backs them, and the third-party Actions/plugins they pull in, then computes an effective-permission map: for every pipeline, exactly what cloud resources, secrets, registries, and repos it can reach if it (or any step it runs) is compromised.

On top of that map CPPA runs a deterministic analysis engine that inventories every pipeline identity and its assumable permissions, resolves the effective (transitive, inherited) privilege of each pipeline, flags over-privileged tokens and recommends a minimal least-privilege replacement, maps the risk inherited from third-party Actions/plugins, computes the blast radius of a poisoned workflow, tracks every secret referenced in CI (scoped, masked, rotated), detects drift in pipeline permissions over time, and exports SOC2 / SLSA audit evidence packs.

Everything is deterministic (no opaque ML scoring) so findings are reproducible and defensible in an audit. The product ships with a built-in sample-data seeder so a signed-in user sees a fully populated org on first login.

See [docs/idea.md](docs/idea.md) for the full product specification and feature breakdown.

## Stack

- Backend: Hono (Node, TypeScript, ESM) running via `tsx`, Drizzle ORM over Neon Postgres (`@neondatabase/serverless`), zod validation.
- Frontend: Next.js 16, React 19, TypeScript (strict), Tailwind CSS 4, App Router.
- Auth: Neon Auth (`@neondatabase/auth`). The Next.js app resolves the session server-side and proxies API calls to the backend with an injected `X-User-Id` header.
- Package manager: pnpm everywhere.

## Repository Layout

- `backend/` — Hono API server. Domain routes mounted under `/api/v1/*`, health at `/health`.
- `web/` — Next.js frontend. API calls go through `/api/proxy/*`, which injects `X-User-Id` from the resolved Neon Auth session.
- `docs/` — product idea and audit docs.
- `render.yaml` — Render deployment config for the backend API.
- `docker-compose.yml` — brings backend and web up together for local containerized runs.

## Local Development

Prerequisites: Node 22+, pnpm, and a Postgres database (Neon recommended).

### Backend

```bash
cd backend
pnpm install
# create backend/.env (see env vars below)
pnpm dev
```

The backend listens on `http://localhost:3001` by default and exposes `/health`.

### Frontend

```bash
cd web
pnpm install
# create web/.env.local (see env vars below)
pnpm dev
```

The frontend runs on `http://localhost:3000`.

### Docker Compose

```bash
docker compose up --build
```

This brings up the backend (port 3001) and web (port 3000) together.

## Environment Variables

### Backend (`backend/.env`)

```
PORT=3001
DATABASE_URL=postgres://user:password@host/db?sslmode=require
FRONTEND_URL=http://localhost:3000
ADMIN_USER_IDS=
# Optional Stripe billing (returns 503 when unset):
# STRIPE_SECRET_KEY=
# STRIPE_PRO_PRICE_ID=
# STRIPE_WEBHOOK_SECRET=
```

### Frontend (`web/.env.local`)

```
NEON_AUTH_BASE_URL=https://<endpoint>.neonauth.<region>.aws.neon.tech/<db>/auth
NEON_AUTH_COOKIE_SECRET=<random 32-byte hex>
NEXT_PUBLIC_API_URL=http://localhost:3001
```

`NEXT_PUBLIC_API_URL` is the only `NEXT_PUBLIC_*` var (baked into the bundle at build time and read by the proxy route). The `NEON_AUTH_*` vars are server-only.

## Pricing

All analysis features are free for signed-in users. Stripe billing is optional: when `STRIPE_SECRET_KEY` is unset, billing endpoints return 503 and every capability remains fully available.
