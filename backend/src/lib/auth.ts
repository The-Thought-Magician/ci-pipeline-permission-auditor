import { createMiddleware } from 'hono/factory'
export type Env = { Variables: { userId: string } }
export const authMiddleware = createMiddleware<Env>(async (c, next) => {
  const userId = c.req.header('X-User-Id') ?? c.req.header('x-user-id')
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)
  c.set('userId', userId)
  await next()
})
export function getUserId(c: any): string {
  return c.get('userId') ?? c.req.header('X-User-Id') ?? c.req.header('x-user-id') ?? ''
}
