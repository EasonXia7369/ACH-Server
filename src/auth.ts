import { Context, Next } from 'hono'
import type { AppContext, SessionUser } from './types.js'

/* ---------- 密码 ---------- */

/**
 * 密码存储格式：
 *  - `pbkdf2:<saltHex>:<hashHex>`   Workers 版标准格式（Web Crypto PBKDF2-SHA256，10 万轮）
 *  - `scrypt:<saltHex>:<hashHex>`   旧 Node 版格式（Workers 无法验证，迁移时重置）
 *  - `legacy-sha256:<syncCode>:<hashHex>`  旧考勤 demo 的学生密码（sha256('wb-class-lock-v1|code|pwd')），
 *    SHA-256 在 Web Crypto 可用，登录时兼容校验
 */

const PBKDF2_ITERATIONS = 100_000

const enc = (s: string) => new TextEncoder().encode(s)

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  )
  return `pbkdf2:${toHex(salt)}:${toHex(bits)}`
}

async function legacyHash(syncCode: string, password: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    enc(`wb-class-lock-v1|${syncCode}|${password}`),
  )
  return toHex(digest)
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  if (stored.startsWith('pbkdf2:')) {
    const [, saltHex, hashHex] = stored.split(':')
    const salt = new Uint8Array((saltHex.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)))
    const key = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
      key,
      256,
    )
    return toHex(bits) === hashHex
  }
  if (stored.startsWith('legacy-sha256:')) {
    const [, syncCode, hash] = stored.split(':')
    return (await legacyHash(syncCode, password)) === hash
  }
  // scrypt: 旧 Node 版用户密码在 Workers 上无法验证（需重置）
  return false
}

export function hashStudentPassword(password: string, legacySyncCode?: string | null): Promise<string> {
  if (legacySyncCode) {
    return legacyHash(legacySyncCode, password).then((h) => `legacy-sha256:${legacySyncCode}:${h}`)
  }
  return hashPassword(password)
}

/* ---------- 会话 ---------- */

const SESSION_DAYS = 30

export async function createSession(
  db: D1Database,
  userId: number | null,
  kind: 'teacher' | 'admin' | 'student',
  classId: number | null,
): Promise<string> {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString()
  await db
    .prepare('INSERT INTO sessions (token, user_id, kind, class_id, expires_at) VALUES (?,?,?,?,?)')
    .bind(token, userId, kind, classId, expires)
    .run()
  return token
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
}

export function bearerToken(c: Context<AppContext>): string {
  return (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '')
}

declare module 'hono' {
  interface ContextVariableMap {
    user?: SessionUser
  }
}

/** 认证中间件：校验 Bearer 会话，挂载 c.var.user。 */
export async function authenticate(c: Context<AppContext>, next: Next) {
  const token = bearerToken(c)
  if (!token) return c.json({ error: '未登录' }, 401)
  const row = await c.env.DB.prepare(
    `SELECT s.kind, s.class_id, s.expires_at, u.id AS uid, u.role, u.name
     FROM sessions s LEFT JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`,
  )
    .bind(token)
    .first<any>()
  if (!row) return c.json({ error: '会话无效' }, 401)
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await destroySession(c.env.DB, token)
    return c.json({ error: '会话已过期' }, 401)
  }
  c.set(
    'user',
    row.kind === 'student'
      ? { userId: 0, role: 'student', name: '学生', classId: row.class_id }
      : { userId: row.uid, role: row.role, name: row.name },
  )
  await next()
}

export function requireRole(...roles: SessionUser['role'][]) {
  return async (c: Context<AppContext>, next: Next) => {
    const user = c.get('user')
    if (!user || !roles.includes(user.role)) return c.json({ error: '权限不足' }, 403)
    await next()
  }
}

/** teacher/admin 对某班级的访问权（admin 全局放行）；student 仅限绑定班级。 */
export async function canAccessClass(
  db: D1Database,
  user: SessionUser,
  classId: number,
): Promise<boolean> {
  if (user.role === 'admin') return true
  if (user.role === 'student') return user.classId === classId
  const row = await db
    .prepare('SELECT 1 AS ok FROM classes WHERE id = ? AND teacher_id = ?')
    .bind(classId, user.userId)
    .first()
  return !!row
}

/* ---------- 邀请码 ---------- */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function genCode(len = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let out = ''
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return out
}
