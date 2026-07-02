import type { HTMLAttributes } from 'react'

type Tone = 'neutral' | 'critical' | 'high' | 'medium' | 'low' | 'success' | 'info' | 'warning'

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone
}

const tones: Record<Tone, string> = {
  neutral: 'bg-slate-800 text-slate-300 border-slate-700',
  critical: 'bg-red-950 text-red-300 border-red-800',
  high: 'bg-orange-950 text-orange-300 border-orange-800',
  medium: 'bg-amber-950 text-amber-300 border-amber-800',
  low: 'bg-sky-950 text-sky-300 border-sky-800',
  success: 'bg-emerald-950 text-emerald-300 border-emerald-800',
  info: 'bg-slate-800 text-slate-300 border-slate-700',
  warning: 'bg-amber-950 text-amber-300 border-amber-800',
}

export function Badge({ tone = 'neutral', className = '', children, ...props }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]} ${className}`}
      {...props}
    >
      {children}
    </span>
  )
}

// Convenience: map a severity string to a badge tone.
export function severityTone(severity?: string): Tone {
  switch ((severity ?? '').toLowerCase()) {
    case 'critical':
      return 'critical'
    case 'high':
      return 'high'
    case 'medium':
      return 'medium'
    case 'low':
      return 'low'
    default:
      return 'neutral'
  }
}

export default Badge
