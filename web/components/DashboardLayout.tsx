'use client'
import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth/client'
import { FullPageSpinner } from '@/components/ui/Spinner'
import {
  LayoutDashboard,
  Cable,
  GitBranch,
  Fingerprint,
  ShieldCheck,
  Boxes,
  Play,
  KeyRound,
  Waypoints,
  TrendingUp,
  Radar,
  History,
  FlaskConical,
  ListChecks,
  Lightbulb,
  ScrollText,
  FileCheck2,
  ClipboardList,
  FileBarChart,
  Users,
  BellRing,
  Activity,
  Settings,
  type LucideIcon,
} from 'lucide-react'

interface NavItem {
  label: string
  href: string
  icon: LucideIcon
}
interface NavSection {
  title: string
  items: NavItem[]
}

const SECTIONS: NavSection[] = [
  {
    title: 'Overview',
    items: [{ label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard }],
  },
  {
    title: 'Inventory',
    items: [
      { label: 'Providers', href: '/dashboard/providers', icon: Cable },
      { label: 'Pipelines', href: '/dashboard/pipelines', icon: GitBranch },
      { label: 'Identities', href: '/dashboard/identities', icon: Fingerprint },
      { label: 'Roles & Permissions', href: '/dashboard/roles', icon: ShieldCheck },
      { label: 'Resources', href: '/dashboard/resources', icon: Boxes },
      { label: 'Actions', href: '/dashboard/actions', icon: Play },
      { label: 'Secrets', href: '/dashboard/secrets', icon: KeyRound },
    ],
  },
  {
    title: 'Analysis',
    items: [
      { label: 'Effective Permissions', href: '/dashboard/effective', icon: Waypoints },
      { label: 'Over-Privilege', href: '/dashboard/over-privilege', icon: TrendingUp },
      { label: 'Blast Radius', href: '/dashboard/blast-radius', icon: Radar },
      { label: 'Drift', href: '/dashboard/drift', icon: History },
      { label: 'Analyzer', href: '/dashboard/analyzer', icon: FlaskConical },
    ],
  },
  {
    title: 'Governance',
    items: [
      { label: 'Findings', href: '/dashboard/findings', icon: ListChecks },
      { label: 'Recommendations', href: '/dashboard/recommendations', icon: Lightbulb },
      { label: 'Policies', href: '/dashboard/policies', icon: ScrollText },
      { label: 'Evidence', href: '/dashboard/evidence', icon: FileCheck2 },
      { label: 'Audits', href: '/dashboard/audits', icon: ClipboardList },
      { label: 'Reports', href: '/dashboard/reports', icon: FileBarChart },
    ],
  },
  {
    title: 'Workspace',
    items: [
      { label: 'Teams', href: '/dashboard/teams', icon: Users },
      { label: 'Alerts & Notifications', href: '/dashboard/alerts', icon: BellRing },
      { label: 'Activity Log', href: '/dashboard/activity', icon: Activity },
      { label: 'Settings', href: '/dashboard/settings', icon: Settings },
    ],
  },
]

const ALL_ITEMS = SECTIONS.flatMap((s) => s.items)

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

  // Icon-only rail for desktop: no text labels, tooltip on hover via title + custom popover.
  const rail = (
    <nav className="flex h-full flex-col items-center gap-1 py-4">
      {ALL_ITEMS.map((item) => {
        const active = isActive(pathname, item.href)
        const Icon = item.icon
        return (
          <div key={item.href} className="group relative">
            <Link
              href={item.href}
              title={item.label}
              aria-label={item.label}
              className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
                active
                  ? 'bg-violet-600/15 text-violet-300 ring-1 ring-inset ring-violet-700/40'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100'
              }`}
            >
              <Icon size={18} strokeWidth={2} />
            </Link>
            <span
              role="tooltip"
              className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs font-medium text-slate-100 opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100"
            >
              {item.label}
            </span>
          </div>
        )
      })}
    </nav>
  )

  // Labeled nav retained for the mobile drawer, where an icon-only rail is impractical.
  const mobileNav = (
    <nav className="flex flex-col gap-6 px-3 py-4">
      {SECTIONS.map((section) => (
        <div key={section.title}>
          <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-600">
            {section.title}
          </div>
          <div className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const active = isActive(pathname, item.href)
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                    active
                      ? 'bg-violet-600/15 font-medium text-violet-300 ring-1 ring-inset ring-violet-700/40'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100'
                  }`}
                >
                  <Icon size={16} strokeWidth={2} />
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
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-slate-800 bg-slate-950/90 px-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <button
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-100 lg:hidden"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label="Toggle navigation"
          >
            ☰
          </button>
          <Link href="/dashboard" className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-violet-500" />
            <span className="text-sm font-bold tracking-tight text-slate-100">CiPipelinePermissionAuditor</span>
          </Link>
        </div>
        <div className="flex items-center gap-4">
          <span className="hidden max-w-[200px] truncate text-sm text-slate-400 sm:inline">{workspaceName}</span>
          <button
            onClick={signOut}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="flex">
        {/* Desktop icon rail */}
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-14 shrink-0 overflow-visible overflow-y-auto border-r border-slate-800 bg-slate-900/40 lg:block">
          {rail}
        </aside>

        {/* Mobile drawer (labeled, for small screens) */}
        {drawerOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-black/60" onClick={() => setDrawerOpen(false)} />
            <aside className="absolute left-0 top-14 h-[calc(100vh-3.5rem)] w-64 overflow-y-auto border-r border-slate-800 bg-slate-900">
              {mobileNav}
            </aside>
          </div>
        )}

        {/* Main content */}
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  )
}
