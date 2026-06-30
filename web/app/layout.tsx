import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'CiPipelinePermissionAuditor',
  description: 'Continuous least-privilege audit and poisoned-pipeline blast-radius analysis for CI/CD machine identities.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 min-h-screen antialiased">{children}</body>
    </html>
  )
}
