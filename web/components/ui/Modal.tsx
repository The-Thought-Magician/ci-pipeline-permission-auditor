'use client'
import { useEffect, type ReactNode } from 'react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}

const sizes = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div
        className={`relative w-full ${sizes[size]} rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl`}
        role="dialog"
        aria-modal="true"
      >
        {title != null && (
          <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
            <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
            <button
              onClick={onClose}
              className="text-zinc-500 hover:text-zinc-200"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        )}
        <div className="px-5 py-4">{children}</div>
        {footer != null && (
          <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-4">{footer}</div>
        )}
      </div>
    </div>
  )
}

export default Modal
