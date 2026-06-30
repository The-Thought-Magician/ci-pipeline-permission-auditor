'use client'
// Local offline dev-auth stub. Same surface as the Neon Auth client the pages use.
async function jpost(path: string, body: unknown) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  return { ok: r.ok, data: await r.json().catch(() => ({})) }
}
export const authClient = {
  signUp: { email: async (a: { name?: string; email: string; password?: string }) => {
    const r = await jpost('/api/auth/login', { email: a.email, name: a.name })
    return r.ok ? { error: null } : { error: { message: 'Sign up failed' } }
  } },
  signIn: { email: async (a: { email: string; password?: string }) => {
    const r = await jpost('/api/auth/login', { email: a.email })
    return r.ok ? { error: null } : { error: { message: 'Sign in failed' } }
  } },
  getSession: async () => {
    const r = await fetch('/api/auth/session')
    const d = await r.json().catch(() => null)
    return d && d.user ? { data: { user: d.user } } : { data: null }
  },
  signOut: async () => { await fetch('/api/auth/logout', { method: 'POST' }) },
}
export default authClient
