import type { Metadata } from 'next'
import { Manrope } from 'next/font/google'
import './globals.css'

const manrope = Manrope({
  subsets: ['latin'],
  variable: '--font-manrope',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'CiPipelinePermissionAuditor',
  description: 'Continuous least-privilege audit and poisoned-pipeline blast-radius analysis for CI/CD machine identities.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={manrope.variable}>
      <body className="bg-slate-950 text-slate-100 min-h-screen antialiased font-sans">{children}</body>
    </html>
  )
}
