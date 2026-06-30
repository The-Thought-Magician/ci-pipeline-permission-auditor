import Link from 'next/link'

const FEATURES = [
  {
    title: 'Pipeline Identity Inventory',
    body: 'Register GitHub Actions, GitLab CI, and Jenkins providers, discover every workflow, and catalog the machine identity, OIDC trust, and assumable cloud roles behind each pipeline.',
  },
  {
    title: 'Effective-Permission Resolver',
    body: 'Follow identity → OIDC trust → assumed roles → inherited Action privilege to compute the transitive set a pipeline can actually reach. Every grant is attributed to an explainable source chain.',
  },
  {
    title: 'Over-Privilege Detector',
    body: 'Compare effective privilege against declared need with a deterministic severity rubric, then ship the exact least-privilege YAML and trust-policy diff to close the gap.',
  },
  {
    title: 'Third-Party Action Risk Map',
    body: 'Catalog every Action, include, and plugin. Flag unpinned tags and mutable refs, surface inherited privilege, and recommend pinning tag → SHA across affected pipelines.',
  },
  {
    title: 'Poisoned-Pipeline Blast Radius',
    body: 'For any workflow, compute the full set of resources, secrets, registries, and downstream pipelines an attacker reaches if it is poisoned — with an attack-path graph and what-if simulation.',
  },
  {
    title: 'Secret-Exposure-in-CI Tracker',
    body: 'Inventory every secret reference and check whether it is scoped, masked, and rotated. Detect plaintext secrets, fork-PR exposure, and overdue rotation with age thresholds.',
  },
  {
    title: 'Drift Detection',
    body: 'Snapshot pipeline permission posture, pin an approved baseline, and diff over time. Surface added permissions, new identities, new Actions, and trust changes as severity-ranked drift findings.',
  },
]

const PROBLEMS = [
  'No effective-privilege map — teams know what a role grants, not what a pipeline can reach.',
  'Over-broad GITHUB_TOKEN / CI tokens, long-lived PATs, and unscoped OIDC sub claims.',
  'Opaque third-party Actions whose transitive privilege is invisible and swappable under you.',
  'Blast radius is unmodeled — nobody can answer "what could the attacker reach?" in audit terms.',
  'Secrets in CI are unaccounted — scoped? masked? ever rotated?',
  'Permission drift is silent and audit evidence is assembled by hand the week before.',
]

export default function Home() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <nav className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-sm bg-red-500" />
          <span className="text-lg font-black tracking-tight text-zinc-100">CiPipelinePermissionAuditor</span>
        </span>
        <div className="flex items-center gap-3 sm:gap-5">
          <Link href="/pricing" className="text-sm text-zinc-300 hover:text-white">
            Pricing
          </Link>
          <Link href="/auth/sign-in" className="text-sm text-zinc-300 hover:text-white">
            Sign In
          </Link>
          <Link
            href="/auth/sign-up"
            className="bg-red-600 hover:bg-red-500 text-white text-sm px-4 py-2 rounded-lg font-medium"
          >
            Get Started
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 py-24 text-center">
        <span className="inline-flex items-center rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-400">
          Deterministic least-privilege auditing for CI/CD
        </span>
        <h1 className="mt-6 text-4xl sm:text-5xl font-black tracking-tight text-zinc-50">
          Audit what your pipelines{' '}
          <span className="text-red-500">can actually do</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-zinc-400">
          One poisoned workflow step inherits far more privilege than the job needs, and one compromise reaches your
          cloud accounts and secrets. CiPipelinePermissionAuditor maps the effective privilege of every CI machine
          identity, computes poisoned-pipeline blast radius, and exports SOC2 / SLSA audit evidence — all deterministic,
          all reproducible.
        </p>
        <div className="mt-9 flex items-center justify-center gap-4">
          <Link
            href="/auth/sign-up"
            className="bg-red-600 hover:bg-red-500 text-white px-6 py-3 rounded-lg font-semibold"
          >
            Start auditing free
          </Link>
          <Link
            href="/auth/sign-in"
            className="border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-100 px-6 py-3 rounded-lg font-semibold"
          >
            Sign in
          </Link>
        </div>
      </section>

      {/* Problem */}
      <section className="border-y border-zinc-800 bg-zinc-900/30">
        <div className="max-w-5xl mx-auto px-6 py-16">
          <h2 className="text-2xl font-bold text-zinc-100">The pipeline-poisoning attack class</h2>
          <p className="mt-2 max-w-3xl text-zinc-400">
            Codecov, tj-actions/changed-files, repeated token-scope abuses — they share one root cause: standing
            over-privilege in build automation that nobody can measure.
          </p>
          <ul className="mt-8 grid gap-4 sm:grid-cols-2">
            {PROBLEMS.map((p) => (
              <li key={p} className="flex gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
                <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-red-500" />
                <span className="text-sm text-zinc-300">{p}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-zinc-100">Seven flagship capabilities</h2>
          <p className="mt-2 text-zinc-400">A complete, deterministic audit-and-evidence engine for CI machine identities.</p>
        </div>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
              <h3 className="text-base font-semibold text-zinc-100">{f.title}</h3>
              <p className="mt-2 text-sm text-zinc-400">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-zinc-800 bg-zinc-900/30">
        <div className="max-w-3xl mx-auto px-6 py-20 text-center">
          <h2 className="text-3xl font-bold text-zinc-100">Contain your blast radius before it matters</h2>
          <p className="mt-3 text-zinc-400">
            Sign up free, seed a fully populated sample org in one click, and see your least-privilege posture in
            minutes.
          </p>
          <div className="mt-8 flex items-center justify-center gap-4">
            <Link
              href="/auth/sign-up"
              className="bg-red-600 hover:bg-red-500 text-white px-6 py-3 rounded-lg font-semibold"
            >
              Create your account
            </Link>
            <Link href="/pricing" className="text-zinc-300 hover:text-white px-6 py-3 font-semibold">
              See pricing
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-zinc-800 py-8 text-center text-zinc-600">
        <p className="text-sm">CiPipelinePermissionAuditor — deterministic CI/CD least-privilege auditing.</p>
      </footer>
    </main>
  )
}
