import type { ReactNode } from 'react'

interface StatProps {
  label: string
  value: ReactNode
  hint?: ReactNode
  accent?: 'default' | 'red' | 'amber' | 'emerald' | 'sky'
}

const accents: Record<NonNullable<StatProps['accent']>, string> = {
  default: 'text-zinc-100',
  red: 'text-red-400',
  amber: 'text-amber-400',
  emerald: 'text-emerald-400',
  sky: 'text-sky-400',
}

export function Stat({ label, value, hint, accent = 'default' }: StatProps) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-5 py-4">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-2 text-2xl font-bold ${accents[accent]}`}>{value}</div>
      {hint != null && <div className="mt-1 text-xs text-zinc-500">{hint}</div>}
    </div>
  )
}

export default Stat
