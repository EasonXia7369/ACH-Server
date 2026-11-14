import { Hono } from 'hono'
import type { AppContext } from '../types.js'
import { authenticate, genCode, requireRole } from '../auth.js'
import { audit } from '../audit.js'
import { importLegacy } from '../import-legacy.js'

export const adminRoutes = new Hono<AppContext>()

adminRoutes.use('/api/admin/*', authenticate, requireRole('admin'))

adminRoutes.post('/api/admin/invites', async (c) => {
  const { role, days } = await c.req.json<{ role?: 'teacher' | 'admin'; days?: number }>()
  if (role !== 'teacher' && role !== 'admin') {
    return c.json({ error: '角色必须为 teacher 或 admin' }, 400)
  }
  const ttl = Math.min(Math.max(days ?? 30, 1), 365)
  const code = genCode(8)
  const expires = new Date(Date.now() + ttl * 86400_000).toISOString()
  await c.env.DB.prepare('INSERT INTO invite_codes (code, role, expires_at) VALUES (?,?,?)')
    .bind(code, role, expires)
    .run()
  await audit(c.env.DB, null, 'admin', c.get('user')!.userId, '生成邀请码', `${role} · ${code}`).run()
  return c.json({ code, role, expires_at: expires })
})

adminRoutes.get('/api/admin/invites', async (c) => {
  const invites = (
    await c.env.DB.prepare(
      `SELECT i.code, i.role, i.used_at, i.expires_at, u.name AS used_by_name
       FROM invite_codes i LEFT JOIN users u ON u.id = i.used_by
       ORDER BY i.rowid DESC LIMIT 100`,
    ).all<any>()
  ).results
  return c.json({ invites })
})

/** 旧 demo 数据导入：body 为 tools/export-legacy.html 导出的 JSON。 */
adminRoutes.post('/api/admin/import-legacy', async (c) => {
  const data = await c.req.json<any>()
  if (data?.app !== 'ark-legacy-export' || !Array.isArray(data.names)) {
    return c.json({ error: '不是有效的旧数据导出文件' }, 400)
  }
  try {
    const result = await importLegacy(c.env.DB, data, c.get('user')!.userId)
    await audit(c.env.DB, result.classId, 'admin', c.get('user')!.userId, '导入旧数据', data.syncCode).run()
    return c.json(result)
  } catch (err: any) {
    return c.json({ error: err.message ?? '导入失败' }, 400)
  }
})
