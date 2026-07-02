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
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <nav className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-sm bg-violet-500" />
          <span className="text-lg font-black tracking-tight text-slate-100">CiPipelinePermissionAuditor</span>
        </span>
        <div className="flex items-center gap-3 sm:gap-5">
          <Link href="/pricing" className="text-sm text-slate-300 hover:text-white">
            Pricing
          </Link>
          <Link href="/auth/sign-in" className="text-sm text-slate-300 hover:text-white">
            Sign In
          </Link>
          <Link
            href="/auth/sign-up"
            className="bg-violet-600 hover:bg-violet-500 text-white text-sm px-4 py-2 rounded-lg font-medium"
          >
            Get Started
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 py-24 text-center">
        <span className="inline-flex items-center rounded-full border border-slate-800 bg-slate-900 px-3 py-1 text-xs font-medium text-slate-400">
          Deterministic least-privilege auditing for CI/CD
        </span>
        <h1 className="mt-6 text-4xl sm:text-5xl font-black tracking-tight text-slate-50">
          Audit what your pipelines{' '}
          <span className="text-violet-500">can actually do</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-400">
          `permissions: write-all` and a broad OIDC token scope on `main` are how one poisoned step reaches your cloud
          account. CiPipelinePermissionAuditor resolves identity → OIDC trust → assumed role → inherited Action
          privilege into the actual effective permission set of every workflow, then ships the least-privilege diff
          to close it — deterministic, reproducible, and mapped to SOC2 / SLSA evidence.
        </p>
        <div className="mt-9 flex items-center justify-center gap-4">
          <Link
            href="/auth/sign-up"
            className="bg-violet-600 hover:bg-violet-500 text-white px-6 py-3 rounded-lg font-semibold"
          >
            Start auditing free
          </Link>
          <Link
            href="/auth/sign-in"
            className="border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-100 px-6 py-3 rounded-lg font-semibold"
          >
            Sign in
          </Link>
        </div>

        {/* Code sample: a real workflow-permissions diff, as produced by the Over-Privilege Detector */}
        <div className="mx-auto mt-14 max-w-2xl overflow-hidden rounded-xl border border-slate-800 bg-slate-900 text-left shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 px-4 py-2">
            <span className="text-xs font-mono text-slate-500">.github/workflows/deploy.yml</span>
            <span className="rounded-full border border-violet-700/40 bg-violet-600/10 px-2 py-0.5 text-[10px] font-medium text-violet-300">
              least-privilege diff
            </span>
          </div>
          <pre className="overflow-x-auto px-4 py-4 text-xs leading-relaxed font-mono">
            <code>
              <span className="text-slate-500">permissions:</span>{'\n'}
              <span className="text-red-400">-  contents: write</span>{'\n'}
              <span className="text-red-400">-  id-token: write</span>{'\n'}
              <span className="text-red-400">-  packages: write</span>{'\n'}
              <span className="text-emerald-400">+  contents: read</span>{'\n'}
              <span className="text-emerald-400">+  id-token: write   # scoped: sub == repo:acme/api:ref:refs/heads/main</span>{'\n'}
              <span className="text-slate-600"># packages: write removed — job never calls a registry push action</span>
            </code>
          </pre>
          <div className="border-t border-slate-800 px-4 py-2 text-xs text-slate-500">
            Detected: <span className="text-slate-300">3 unused grants</span> · Blast radius reduced from{' '}
            <span className="text-slate-300">14 resources → 2</span>
          </div>
        </div>
      </section>

      {/* Problem */}
      <section className="border-y border-slate-800 bg-slate-900/30">
        <div className="max-w-5xl mx-auto px-6 py-16">
          <h2 className="text-2xl font-bold text-slate-100">The pipeline-poisoning attack class</h2>
          <p className="mt-2 max-w-3xl text-slate-400">
            Codecov, tj-actions/changed-files, repeated token-scope abuses — they share one root cause: standing
            over-privilege in build automation that nobody can measure.
          </p>
          <ul className="mt-8 grid gap-4 sm:grid-cols-2">
            {PROBLEMS.map((p) => (
              <li key={p} className="flex gap-3 rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3">
                <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-violet-500" />
                <span className="text-sm text-slate-300">{p}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-slate-100">Seven flagship capabilities</h2>
          <p className="mt-2 text-slate-400">A complete, deterministic audit-and-evidence engine for CI machine identities.</p>
        </div>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
              <h3 className="text-base font-semibold text-slate-100">{f.title}</h3>
              <p className="mt-2 text-sm text-slate-400">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-slate-800 bg-slate-900/30">
        <div className="max-w-3xl mx-auto px-6 py-20 text-center">
          <h2 className="text-3xl font-bold text-slate-100">Contain your blast radius before it matters</h2>
          <p className="mt-3 text-slate-400">
            Sign up free, seed a fully populated sample org in one click, and see your least-privilege posture in
            minutes.
          </p>
          <div className="mt-8 flex items-center justify-center gap-4">
            <Link
              href="/auth/sign-up"
              className="bg-violet-600 hover:bg-violet-500 text-white px-6 py-3 rounded-lg font-semibold"
            >
              Create your account
            </Link>
            <Link href="/pricing" className="text-slate-300 hover:text-white px-6 py-3 font-semibold">
              See pricing
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-800 py-8 text-center text-slate-600">
        <p className="text-sm">CiPipelinePermissionAuditor — deterministic CI/CD least-privilege auditing.</p>
      </footer>
    </main>
  )
}
