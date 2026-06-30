'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { authClient } from '@/lib/auth/client'

export default function SignIn() {
  const router = useRouter()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    const fd = new FormData(e.currentTarget)
    const { error } = await authClient.signIn.email({
      email: fd.get('email') as string,
      password: fd.get('password') as string,
    })
    setLoading(false)
    if (error) {
      setError(error.message ?? 'Failed to sign in')
      return
    }
    router.push('/dashboard')
  }

  return (
    <main className="min-h-screen bg-zinc-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-sm bg-red-500" />
            <span className="text-xl font-black tracking-tight text-zinc-100">CiPipelinePermissionAuditor</span>
          </Link>
          <h1 className="text-2xl font-bold mt-6 text-zinc-100">Sign in to your account</h1>
          <p className="mt-1 text-sm text-zinc-500">Continuous least-privilege audit for CI/CD identities.</p>
        </div>
        <form onSubmit={handleSubmit} className="bg-zinc-900 rounded-xl border border-zinc-800 p-8 space-y-4">
          {error && (
            <div className="bg-red-950/40 border border-red-800 text-red-300 rounded-lg p-3 text-sm">{error}</div>
          )}
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Email</label>
            <input
              name="email"
              type="email"
              required
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-zinc-100 focus:outline-none focus:border-red-500"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Password</label>
            <input
              name="password"
              type="password"
              required
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-zinc-100 focus:outline-none focus:border-red-500"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white py-3 rounded-lg font-semibold transition-colors"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
          <p className="text-center text-zinc-400 text-sm">
            No account?{' '}
            <Link href="/auth/sign-up" className="text-red-400 hover:text-red-300">
              Sign up
            </Link>
          </p>
        </form>
      </div>
    </main>
  )
}
