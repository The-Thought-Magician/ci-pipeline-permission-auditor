import { NextRequest, NextResponse } from 'next/server'

function uidFor(email: string): string {
  let h = 0
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0
  return 'local-' + h.toString(16)
}

async function handler(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  const seg = (path || []).join('/')
  if (seg === 'login') {
    const b = await req.json().catch(() => ({} as any))
    const email = (b.email as string) || 'dev@local'
    const uid = uidFor(email)
    const res = NextResponse.json({ ok: true, user: { id: uid, email } })
    res.cookies.set('uid', uid, { httpOnly: true, path: '/', sameSite: 'lax' })
    res.cookies.set('uemail', email, { path: '/', sameSite: 'lax' })
    return res
  }
  if (seg === 'logout') {
    const res = NextResponse.json({ ok: true })
    res.cookies.delete('uid')
    res.cookies.delete('uemail')
    return res
  }
  if (seg === 'session') {
    const uid = req.cookies.get('uid')?.value
    const email = req.cookies.get('uemail')?.value
    return NextResponse.json(uid ? { user: { id: uid, email } } : { user: null })
  }
  return NextResponse.json({ ok: false }, { status: 404 })
}
export const GET = handler
export const POST = handler
