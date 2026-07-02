interface SpinnerProps {
  className?: string
  label?: string
}

export function Spinner({ className = '', label }: SpinnerProps) {
  return (
    <span className="inline-flex items-center gap-2 text-slate-400">
      <span
        className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-700 border-t-red-500 ${className}`}
        role="status"
        aria-label={label ?? 'Loading'}
      />
      {label && <span className="text-sm">{label}</span>}
    </span>
  )
}

export function FullPageSpinner({ label = 'Loading...' }: { label?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950">
      <Spinner label={label} />
    </div>
  )
}

export default Spinner
