'use client'
import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth/client'
import { FullPageSpinner } from '@/components/ui/Spinner'

interface NavItem {
  label: string
  href: string
}
interface NavSection {
  title: string
  items: NavItem[]
}

const SECTIONS: NavSection[] = [
  {
    title: 'Overview',
    items: [{ label: 'Dashboard', href: '/dashboard' }],
  },
  {
    title: 'Inventory',
    items: [
      { label: 'Providers', href: '/dashboard/providers' },
      { label: 'Pipelines', href: '/dashboard/pipelines' },
      { label: 'Identities', href: '/dashboard/identities' },
      { label: 'Roles & Permissions', href: '/dashboard/roles' },
      { label: 'Resources', href: '/dashboard/resources' },
      { label: 'Actions', href: '/dashboard/actions' },
      { label: 'Secrets', href: '/dashboard/secrets' },
    ],
  },
  {
    title: 'Analysis',
    items: [
      { label: 'Effective Permissions', href: '/dashboard/effective' },
      { label: 'Over-Privilege', href: '/dashboard/over-privilege' },
      { label: 'Blast Radius', href: '/dashboard/blast-radius' },
      { label: 'Drift', href: '/dashboard/drift' },
      { label: 'Analyzer', href: '/dashboard/analyzer' },
    ],
  },
  {
    title: 'Governance',
    items: [
      { label: 'Findings', href: '/dashboard/findings' },
      { label: 'Recommendations', href: '/dashboard/recommendations' },
      { label: 'Policies', href: '/dashboard/policies' },
      { label: 'Evidence', href: '/dashboard/evidence' },
      { label: 'Audits', href: '/dashboard/audits' },
      { label: 'Reports', href: '/dashboard/reports' },
    ],
  },
  {
    title: 'Workspace',
    items: [
      { label: 'Teams', href: '/dashboard/teams' },
      { label: 'Alerts & Notifications', href: '/dashboard/alerts' },
      { label: 'Activity Log', href: '/dashboard/activity' },
      { label: 'Settings', href: '/dashboard/settings' },
    ],
  },
]

function isActive(pathname: string, href: string) {
  if (href === '/dashboard') return pathname === '/dashboard'
  return pathname === href || pathname.startsWith(`${href}/`)
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [checking, setChecking] = useState(true)
  const [authed, setAuthed] = useState(false)
  const [workspaceName, setWorkspaceName] = useState('Workspace')
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const s = await authClient.getSession()
      if (cancelled) return
      const user = (s as any)?.data?.user ?? (s as any)?.user
      if (!user) {
        router.push('/auth/sign-in')
        return
      }
      setWorkspaceName(user.name || user.email || 'Workspace')
      setAuthed(true)
      setChecking(false)
    })()
    return () => {
      cancelled = true
    }
  }, [router])

  // Close the mobile drawer on navigation.
  useEffect(() => {
    setDrawerOpen(false)
  }, [pathname])

  const signOut = async () => {
    await authClient.signOut()
    router.push('/')
  }

  if (checking || !authed) return <FullPageSpinner label="Checking session..." />

  const nav = (
    <nav className="flex flex-col gap-6 px-3 py-4">
      {SECTIONS.map((section) => (
        <div key={section.title}>
          <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
            {section.title}
          </div>
          <div className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const active = isActive(pathname, item.href)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-lg px-3 py-2 text-sm transition-colors ${
                    active
                      ? 'bg-red-600/15 font-medium text-red-300 ring-1 ring-inset ring-red-700/40'
                      : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100'
                  }`}
                >
                  {item.label}
                </Link>
              )
            })}
          </div>
        </div>
      ))}
    </nav>
  )

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-zinc-800 bg-zinc-950/90 px-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <button
            className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 lg:hidden"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label="Toggle navigation"
          >
            ☰
          </button>
          <Link href="/dashboard" className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-red-500" />
            <span className="text-sm font-bold tracking-tight text-zinc-100">CiPipelinePermissionAuditor</span>
          </Link>
        </div>
        <div className="flex items-center gap-4">
          <span className="hidden max-w-[200px] truncate text-sm text-zinc-400 sm:inline">{workspaceName}</span>
          <button
            onClick={signOut}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="flex">
        {/* Desktop sidebar */}
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-64 shrink-0 overflow-y-auto border-r border-zinc-800 bg-zinc-900/40 lg:block">
          {nav}
        </aside>

        {/* Mobile drawer */}
        {drawerOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-black/60" onClick={() => setDrawerOpen(false)} />
            <aside className="absolute left-0 top-14 h-[calc(100vh-3.5rem)] w-64 overflow-y-auto border-r border-zinc-800 bg-zinc-900">
              {nav}
            </aside>
          </div>
        )}

        {/* Main content */}
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  )
}
