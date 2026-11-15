import { Hono } from 'hono'
import type { AppContext } from '../types.js'
import { authenticate, genCode, hashPassword, requireRole } from '../auth.js'
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

/* ---------- 账号管理 ---------- */

adminRoutes.get('/api/admin/users', async (c) => {
  const users = (
    await c.env.DB.prepare(
      `SELECT u.id, u.name, u.role, u.created_at,
              (SELECT COUNT(*) FROM classes c WHERE c.teacher_id = u.id) AS class_count
       FROM users u ORDER BY u.id`,
    ).all<any>()
  ).results
  return c.json({ users })
})

/** 管理员重置任意账号密码（新密码由管理员提供）。 */
adminRoutes.post('/api/admin/users/:id/reset-password', async (c) => {
  const uid = Number(c.req.param('id'))
  const admin = c.get('user')!
  const { password } = await c.req.json<{ password?: string }>()
  if (!password || password.length < 4) return c.json({ error: '密码至少 4 位' }, 400)
  const user = await c.env.DB.prepare('SELECT id, name, role FROM users WHERE id = ?')
    .bind(uid)
    .first<any>()
  if (!user) return c.json({ error: '账号不存在' }, 404)
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').bind(await hashPassword(password), uid),
    // 强制该账号所有会话下线
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid),
  ])
  await audit(c.env.DB, null, 'admin', admin.userId, '重置密码', `${user.name}（${user.role}）`).run()
  return c.json({ ok: true })
})

/** 班级转让给另一位班主任。body: { teacher_id } */
adminRoutes.post('/api/admin/classes/:id/transfer', async (c) => {
  const classId = Number(c.req.param('id'))
  const admin = c.get('user')!
  const { teacher_id } = await c.req.json<{ teacher_id?: number }>()
  if (!teacher_id) return c.json({ error: 'teacher_id 必填' }, 400)
  const cls = await c.env.DB.prepare('SELECT id, name, teacher_id FROM classes WHERE id = ?')
    .bind(classId)
    .first<any>()
  if (!cls) return c.json({ error: '班级不存在' }, 404)
  const target = await c.env.DB.prepare("SELECT id, name, role FROM users WHERE id = ?1 AND role = 'teacher'")
    .bind(teacher_id)
    .first<any>()
  if (!target) return c.json({ error: '目标账号不存在或不是教师' }, 400)
  if (cls.teacher_id === teacher_id) return c.json({ error: '该班已属于这位教师' }, 400)
  const old = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(cls.teacher_id).first<{ name: string }>()
  await c.env.DB.prepare('UPDATE classes SET teacher_id = ? WHERE id = ?').bind(teacher_id, classId).run()
  await audit(
    c.env.DB,
    classId,
    'admin',
    admin.userId,
    '班级转让',
    `${cls.name}：${old?.name ?? cls.teacher_id} → ${target.name}`,
  ).run()
  return c.json({ ok: true })
})
