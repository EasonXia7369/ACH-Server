import { Hono } from 'hono'
import type { AppContext } from '../types.js'
import {
  authenticate,
  bearerToken,
  createSession,
  destroySession,
  hashPassword,
  verifyPassword,
  defaultSchoolId,
} from '../auth.js'
import { audit } from '../audit.js'

export const authRoutes = new Hono<AppContext>()

/** 首个管理员：用 ARK_BOOTSTRAP_CODE 作为一次性引导码激活（平台超管）。 */
authRoutes.post('/api/auth/activate', async (c) => {
  const { code, name, password } = await c.req.json<{
    code?: string
    name?: string
    password?: string
  }>()
  if (!code || !name?.trim() || !password) return c.json({ error: '参数不完整' }, 400)
  if (password.length < 4) return c.json({ error: '密码至少 4 位' }, 400)

  const bootstrap = c.env.ARK_BOOTSTRAP_CODE
  let role: 'teacher' | 'admin'
  /** 激活后的学校归属：NULL = 平台级（超管/平台教师） */
  let schoolId: number | null = null
  let invite: any = null

  if (bootstrap && code === bootstrap) {
    const exists = await c.env.DB
      .prepare("SELECT 1 AS ok FROM users WHERE role = 'admin' LIMIT 1")
      .first()
    if (exists) return c.json({ error: '管理员已存在，引导码已失效' }, 400)
    role = 'admin'
  } else {
    invite = await c.env.DB.prepare('SELECT * FROM invite_codes WHERE code = ?')
      .bind(code)
      .first<any>()
    if (!invite) return c.json({ error: '邀请码不存在' }, 400)
    if (invite.used_by) return c.json({ error: '邀请码已被使用' }, 400)
    if (new Date(invite.expires_at).getTime() < Date.now()) {
      return c.json({ error: '邀请码已过期' }, 400)
    }
    role = invite.role
    // 学校归属：校管理员/教师邀请绑定学校；平台超管发的教师邀请（school_id NULL）归默认学校
    schoolId =
      invite.school_id ?? (role === 'teacher' ? await defaultSchoolId(c.env.DB) : null)
  }

  const dup = await c.env.DB.prepare('SELECT 1 AS ok FROM users WHERE name = ?')
    .bind(name.trim())
    .first()
  if (dup) return c.json({ error: '该姓名已被使用' }, 400)

  const passHash = await hashPassword(password)
  const ins = await c.env.DB
    .prepare('INSERT INTO users (name, role, pass_hash, school_id) VALUES (?,?,?,?)')
    .bind(name.trim(), role, passHash, schoolId)
    .run()
  const userId = ins.meta.last_row_id as number

  if (invite) {
    await c.env.DB.prepare('UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code = ?')
      .bind(userId, new Date().toISOString(), code)
      .run()
  }

  const token = await createSession(c.env.DB, userId, role, null)
  return c.json({ token, user: { id: userId, name: name.trim(), role, schoolId } })
})

authRoutes.post('/api/auth/login', async (c) => {
  const { name, password } = await c.req.json<{ name?: string; password?: string }>()
  if (!name || !password) return c.json({ error: '参数不完整' }, 400)
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE name = ?')
    .bind(name.trim())
    .first<any>()
  if (!user || !(await verifyPassword(user.pass_hash, password))) {
    return c.json({ error: '姓名或密码错误' }, 401)
  }
  const token = await createSession(c.env.DB, user.id, user.role, null)
  return c.json({
    token,
    user: { id: user.id, name: user.name, role: user.role, schoolId: user.school_id },
  })
})

authRoutes.post('/api/auth/logout', authenticate, async (c) => {
  await destroySession(c.env.DB, bearerToken(c))
  return c.json({ ok: true })
})

authRoutes.get('/api/auth/me', authenticate, async (c) => {
  return c.json({ user: c.get('user') })
})

/** 修改自己的密码（教师/管理员；学生无独立密码）。 */
authRoutes.post('/api/auth/password', authenticate, async (c) => {
  const user = c.get('user')!
  if (user.role === 'student') return c.json({ error: '学生没有独立密码' }, 403)
  const { old: oldPass, new: newPass } = await c.req.json<{ old?: string; new?: string }>()
  if (!oldPass || !newPass) return c.json({ error: '参数不完整' }, 400)
  if (newPass.length < 4) return c.json({ error: '新密码至少 4 位' }, 400)
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.userId).first<any>()
  if (!row || !(await verifyPassword(row.pass_hash, oldPass))) {
    return c.json({ error: '原密码错误' }, 401)
  }
  await c.env.DB.prepare('UPDATE users SET pass_hash = ? WHERE id = ?')
    .bind(await hashPassword(newPass), row.id)
    .run()
  await audit(c.env.DB, null, user.role, user.userId, '修改密码', user.name).run()
  return c.json({ ok: true })
})
