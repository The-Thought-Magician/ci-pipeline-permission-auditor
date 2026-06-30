'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import api from '@/lib/api'

const FREE_FEATURES = [
  'Pipeline identity inventory across GitHub Actions, GitLab CI, Jenkins',
  'Effective-permission resolver with explainable source chains',
  'Over-privilege detector + least-privilege diffs',
  'Third-party Action / plugin risk map',
  'Poisoned-pipeline blast radius + attack-path graph + what-if simulation',
  'Secret-in-CI tracker (scoped / masked / rotated)',
  'Drift detection, snapshots, and baselines',
  'SOC2 / SLSA evidence packs and exportable reports',
  'Policies, audits, alerts, and immutable activity log',
  'One-click sample-data seeder',
]

export default function Pricing() {
  const [stripeEnabled, setStripeEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.getBillingPlan()
        if (!cancelled) setStripeEnabled(Boolean(res?.stripeEnabled))
      } catch {
        // Billing/plan requires a session; pricing is public so silently ignore.
        if (!cancelled) setStripeEnabled(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <nav className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-sm bg-red-500" />
          <span className="text-lg font-black tracking-tight text-zinc-100">CiPipelinePermissionAuditor</span>
        </Link>
        <div className="flex items-center gap-3 sm:gap-5">
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

      <section className="max-w-4xl mx-auto px-6 py-20 text-center">
        <h1 className="text-4xl font-black tracking-tight text-zinc-50">Simple pricing</h1>
        <p className="mt-4 text-lg text-zinc-400">
          Every analysis feature is free for signed-in users. Stripe billing is optional and returns 503 when
          unconfigured — there is nothing to pay for today.
        </p>
      </section>

      <section className="max-w-4xl mx-auto px-6 pb-24 grid gap-6 md:grid-cols-2">
        {/* Free plan */}
        <div className="rounded-2xl border border-red-700/50 bg-zinc-900/60 p-8 ring-1 ring-inset ring-red-700/20">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-zinc-100">Free</h2>
            <span className="rounded-full border border-emerald-800 bg-emerald-950 px-2 py-0.5 text-xs font-medium text-emerald-300">
              All features
            </span>
          </div>
          <div className="mt-4 flex items-baseline gap-1">
            <span className="text-4xl font-black text-zinc-50">$0</span>
            <span className="text-zinc-500">/ forever</span>
          </div>
          <p className="mt-2 text-sm text-zinc-400">Full deterministic audit engine for every CI machine identity.</p>
          <ul className="mt-6 space-y-3">
            {FREE_FEATURES.map((f) => (
              <li key={f} className="flex gap-3 text-sm text-zinc-300">
                <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-red-500" />
                {f}
              </li>
            ))}
          </ul>
          <Link
            href="/auth/sign-up"
            className="mt-8 block rounded-lg bg-red-600 px-4 py-3 text-center font-semibold text-white hover:bg-red-500"
          >
            Start free
          </Link>
        </div>

        {/* Pro plan (optional, not enabled) */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-zinc-100">Pro</h2>
            <span className="rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-400">
              {stripeEnabled === null ? 'Checking...' : stripeEnabled ? 'Available' : 'Not enabled'}
            </span>
          </div>
          <div className="mt-4 flex items-baseline gap-1">
            <span className="text-4xl font-black text-zinc-50">$0</span>
            <span className="text-zinc-500">/ today</span>
          </div>
          <p className="mt-2 text-sm text-zinc-400">
            A placeholder for future paid tiers (longer retention, SSO, priority support). Billing is optional and
            disabled in this deployment, so all capabilities remain on the Free plan.
          </p>
          <ul className="mt-6 space-y-3">
            <li className="flex gap-3 text-sm text-zinc-400">
              <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-zinc-600" />
              Everything in Free
            </li>
            <li className="flex gap-3 text-sm text-zinc-400">
              <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-zinc-600" />
              Extended snapshot retention (planned)
            </li>
            <li className="flex gap-3 text-sm text-zinc-400">
              <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-zinc-600" />
              SSO &amp; org controls (planned)
            </li>
          </ul>
          <div className="mt-8 rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3 text-center text-sm text-zinc-500">
            {stripeEnabled
              ? 'Upgrade options are available from your workspace settings.'
              : 'Billing is not configured. All features are free.'}
          </div>
        </div>
      </section>

      <footer className="border-t border-zinc-800 py-8 text-center text-zinc-600">
        <p className="text-sm">CiPipelinePermissionAuditor — deterministic CI/CD least-privilege auditing.</p>
      </footer>
    </main>
  )
}
