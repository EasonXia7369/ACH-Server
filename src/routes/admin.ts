import { Hono } from 'hono'
import type { AppContext } from '../types.js'
import {
  authenticate,
  genCode,
  hashPassword,
  requireRole,
  requirePlatformAdmin,
  isSchoolAdmin,
} from '../auth.js'
import { audit } from '../audit.js'
import { importLegacy } from '../import-legacy.js'

export const adminRoutes = new Hono<AppContext>()

// /api/admin/* = 平台超管专用（校管理员走 /api/school/*，见 routes/school.ts）
adminRoutes.use('/api/admin/*', authenticate, requireRole('admin'), requirePlatformAdmin())

adminRoutes.post('/api/admin/invites', async (c) => {
  const { role, days, school_id } = await c.req.json<{
    role?: 'teacher' | 'admin'
    days?: number
    school_id?: number
  }>()
  if (role !== 'teacher' && role !== 'admin') {
    return c.json({ error: '角色必须为 teacher 或 admin' }, 400)
  }
  const ttl = Math.min(Math.max(days ?? 30, 1), 365)
  const code = genCode(8)
  const expires = new Date(Date.now() + ttl * 86400_000).toISOString()
  // school_id：为指定学校发邀请（教师入该校 / 校管理员管理该校）；NULL = 平台超管
  let schoolName: string | null = null
  if (school_id != null) {
    const s = await c.env.DB.prepare('SELECT name FROM schools WHERE id = ?1')
      .bind(school_id)
      .first<{ name: string }>()
    if (!s) return c.json({ error: '学校不存在' }, 400)
    schoolName = s.name
  }
  await c.env.DB
    .prepare('INSERT INTO invite_codes (code, role, school_id, expires_at) VALUES (?,?,?,?)')
    .bind(code, role, school_id ?? null, expires)
    .run()
  await audit(
    c.env.DB,
    null,
    'admin',
    c.get('user')!.userId,
    '生成邀请码',
    `${role}${schoolName ? ` · ${schoolName}` : ''} · ${code}`,
  ).run()
  return c.json({ code, role, school_id: school_id ?? null, expires_at: expires })
})

adminRoutes.get('/api/admin/invites', async (c) => {
  const invites = (
    await c.env.DB.prepare(
      `SELECT i.code, i.role, i.school_id, s.name AS school_name, i.used_at, i.expires_at, u.name AS used_by_name
       FROM invite_codes i
       LEFT JOIN schools s ON s.id = i.school_id
       LEFT JOIN users u ON u.id = i.used_by
       ORDER BY i.rowid DESC LIMIT 100`,
    ).all<any>()
  ).results
  return c.json({ invites })
})

/* ---------- 学校管理（平台超管） ---------- */

adminRoutes.get('/api/admin/schools', async (c) => {
  const schools = (
    await c.env.DB.prepare(
      `SELECT s.id, s.name, s.created_at,
              (SELECT COUNT(*) FROM classes c WHERE c.school_id = s.id) AS class_count,
              (SELECT COUNT(*) FROM users u WHERE u.school_id = s.id AND u.role = 'teacher') AS teacher_count
       FROM schools s ORDER BY s.id`,
    ).all<any>()
  ).results
  return c.json({ schools })
})

/** 建学校（可同时创建首任校管理员）。body: { name, admin_name?, admin_password? } */
adminRoutes.post('/api/admin/schools', async (c) => {
  const { name, admin_name, admin_password } = await c.req.json<{
    name?: string
    admin_name?: string
    admin_password?: string
  }>()
  if (!name?.trim()) return c.json({ error: '学校名称必填' }, 400)
  const dup = await c.env.DB.prepare('SELECT 1 AS ok FROM schools WHERE name = ?1')
    .bind(name.trim())
    .first()
  if (dup) return c.json({ error: '该学校名称已存在' }, 400)
  if ((admin_name?.trim() || admin_password) && (!admin_name?.trim() || !admin_password)) {
    return c.json({ error: '校管理员姓名与密码需同时提供' }, 400)
  }
  if (admin_name?.trim() && admin_password) {
    if (admin_password.length < 4) return c.json({ error: '密码至少 4 位' }, 400)
    const dupUser = await c.env.DB.prepare('SELECT 1 AS ok FROM users WHERE name = ?1')
      .bind(admin_name.trim())
      .first()
    if (dupUser) return c.json({ error: '该姓名已被使用' }, 400)
  }

  const insSchool = await c.env.DB
    .prepare('INSERT INTO schools (name) VALUES (?)')
    .bind(name.trim())
    .run()
  const schoolId = insSchool.meta.last_row_id as number

  let adminUser: { id: number; name: string } | null = null
  if (admin_name?.trim() && admin_password) {
    const insUser = await c.env.DB
      .prepare("INSERT INTO users (name, role, pass_hash, school_id) VALUES (?1,'admin',?2,?3)")
      .bind(admin_name.trim(), await hashPassword(admin_password), schoolId)
      .run()
    adminUser = { id: insUser.meta.last_row_id as number, name: admin_name.trim() }
  }
  await audit(c.env.DB, null, 'admin', c.get('user')!.userId, '创建学校', name.trim()).run()
  return c.json({ school: { id: schoolId, name: name.trim() }, admin: adminUser })
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

/* ---------- 账号管理（平台超管） ---------- */

/** 平台超管直接创建账号：教师（可指定学校，默认默认学校）。 */
adminRoutes.post('/api/admin/users', async (c) => {
  const { name, password, school_id } = await c.req.json<{
    name?: string
    password?: string
    school_id?: number
  }>()
  if (!name?.trim() || !password) return c.json({ error: '姓名和密码必填' }, 400)
  if (password.length < 4) return c.json({ error: '密码至少 4 位' }, 400)
  const dup = await c.env.DB.prepare('SELECT 1 AS ok FROM users WHERE name = ?1')
    .bind(name.trim())
    .first()
  if (dup) return c.json({ error: '该姓名已被使用' }, 400)
  let schoolId: number | null = null
  if (school_id != null) {
    const s = await c.env.DB.prepare('SELECT id FROM schools WHERE id = ?1')
      .bind(school_id)
      .first()
    if (!s) return c.json({ error: '学校不存在' }, 400)
    schoolId = school_id
  } else {
    schoolId = await c.env.DB.prepare('SELECT MIN(id) AS id FROM schools').first<{ id: number }>().then((r) => r?.id ?? null)
  }
  const ins = await c.env.DB
    .prepare("INSERT INTO users (name, role, pass_hash, school_id) VALUES (?1,'teacher',?2,?3)")
    .bind(name.trim(), await hashPassword(password), schoolId)
    .run()
  await audit(c.env.DB, null, 'admin', c.get('user')!.userId, '创建教师账号', name.trim()).run()
  return c.json({
    user: { id: ins.meta.last_row_id as number, name: name.trim(), role: 'teacher', school_id: schoolId },
  })
})

adminRoutes.get('/api/admin/users', async (c) => {
  const users = (
    await c.env.DB.prepare(
      `SELECT u.id, u.name, u.role, u.school_id, s.name AS school_name, u.created_at,
              (SELECT COUNT(*) FROM classes c WHERE c.teacher_id = u.id) AS class_count
       FROM users u LEFT JOIN schools s ON s.id = u.school_id ORDER BY u.id`,
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
