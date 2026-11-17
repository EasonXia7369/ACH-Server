import { Hono } from 'hono'
import type { AppContext } from '../types.js'
import { authenticate, bearerToken, canAccessClass, sessionFromToken } from '../auth.js'
import { broadcast, broadcastRefresh } from '../realtime.js'
import { pushClass, sideTask } from '../push.js'

/** 发起操作的设备 id（X-Push-Device 头）：推送时排除发送者自己的设备 */
function senderDevice(c: any): string | undefined {
  return c.req.header('X-Push-Device') || undefined
}

export const messageRoutes = new Hono<AppContext>()

const MAX_MEDIA_BYTES = 400 * 1024
const MAX_TEXT = 500
const ALLOWED_MIME = ['image/webp', 'image/jpeg', 'image/png', 'audio/webm', 'audio/ogg', 'audio/mp4']

function dateOf(v?: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

/** 会话 → 广播身份（值日生统一为 student；管理员以老师身份参与）。 */
async function resolveSender(
  c: any,
  classId: number,
): Promise<{ role: 'teacher' | 'student'; userId: number | null } | null> {
  const user = c.get('user')!
  if (user.role === 'student') {
    return user.classId === classId ? { role: 'student', userId: null } : null
  }
  if (user.role === 'teacher') {
    const ok = await c.env.DB
      .prepare(
        `SELECT 1 AS ok WHERE EXISTS (
         SELECT 1 FROM classes WHERE id = ?1 AND teacher_id = ?2
       ) OR EXISTS (
         SELECT 1 FROM class_teachers WHERE class_id = ?1 AND user_id = ?2
       )`,
      )
      .bind(classId, user.userId)
      .first()
    return ok ? { role: 'teacher', userId: user.userId } : null
  }
  if (user.role === 'admin') {
    const ok = await c.env.DB.prepare('SELECT 1 AS ok FROM classes WHERE id = ?1')
      .bind(classId)
      .first()
    return ok ? { role: 'teacher', userId: user.userId } : null
  }
  return null
}


/** 历史 / 增量：?after=<最后见过的 id>，返回该 id 之后的消息（不含 BLOB）。 */
messageRoutes.get(
  '/api/classes/:id/messages',
  authenticate,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const sender = await resolveSender(c, classId)
    if (!sender) return c.json({ error: '无权访问该班级消息' }, 403)
    const after = Number(c.req.query('after') ?? 0) || 0
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 300)
    const rows = (
      await c.env.DB.prepare(
        `SELECT m.id, m.class_id, m.sender_role, m.kind, m.body, m.media_mime, m.media_duration_ms, m.created_at, m.popup,
                (m.media IS NOT NULL) AS has_media,
                COALESCE(st.name, CASE WHEN m.sender_role = 'student' THEN '值日生' ELSE '老师' END) AS sender_name, m.actor_student_id
         FROM messages m
         LEFT JOIN students st ON st.id = m.actor_student_id
         WHERE m.class_id = ?1 AND m.id > ?2 AND m.deleted = 0 ORDER BY m.id ASC LIMIT ?3`,
      )
        .bind(classId, after, limit)
        .all<any>()
    ).results.map((r) => ({ ...r, popup: !!r.popup }))
    return c.json({ messages: rows })
  },
)

/** 发送文字消息（老师 / 值日生一体机）。body: { body: string } */
messageRoutes.post(
  '/api/classes/:id/messages',
  authenticate,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const sender = await resolveSender(c, classId)
    if (!sender) return c.json({ error: '无权在该班级发送消息' }, 403)
    const { body, actor_student_id, popup } = await c.req.json<{
      body?: string
      actor_student_id?: number
      popup?: boolean
    }>()
    const text = (body ?? '').trim()
    if (!text) return c.json({ error: '消息内容不能为空' }, 400)
    if (text.length > MAX_TEXT) return c.json({ error: '消息最长 500 字' }, 400)
    const popupFlag = popup === false ? 0 : 1

    // 值日生可认领身份：校验学生属于本班，消息记到人
    let actorName: string | null = null
    let actorId: number | null = null
    if (sender.role === 'student' && actor_student_id) {
      const stu = await c.env.DB
        .prepare('SELECT name FROM students WHERE id = ?1 AND class_id = ?2 AND active = 1')
        .bind(actor_student_id, classId)
        .first<{ name: string }>()
      if (!stu) return c.json({ error: '认领的学生不属于该班级' }, 400)
      actorName = stu.name
      actorId = actor_student_id
    }

    const ins = await c.env.DB.prepare(
      `INSERT INTO messages (class_id, sender_role, actor_student_id, kind, body, popup) VALUES (?1,?2,?3,'text',?4,?5)`,
    )
      .bind(classId, sender.role, actorId, text, popupFlag)
      .run()
    const id = ins.meta.last_row_id as number
    const created = await c.env.DB.prepare('SELECT created_at FROM messages WHERE id = ?')
      .bind(id)
      .first<{ created_at: string }>()

    const message = {
      id,
      class_id: classId,
      sender_role: sender.role,
      sender_name: actorName ?? (sender.role === 'student' ? '值日生' : '老师'),
      actor_student_id: actorId,
      kind: 'text' as const,
      body: text,
      popup: popupFlag === 1,
      has_media: false,
      media_mime: null,
      media_duration_ms: null,
      created_at: created?.created_at ?? new Date().toISOString(),
    }
    await broadcast(c.env, classId, { type: 'message', message })
    // Web Push：发给全班订阅设备（发送者自身设备除外）；不阻塞响应
    sideTask(c, () =>
      pushClass(
        c.env,
        classId,
        {
          type: 'message',
          title:
            sender.role === 'teacher'
              ? '老师来消息了'
              : actorName
                ? `${actorName}来消息了`
                : '值日生来消息了',
          body: text,
        },
        senderDevice(c),
      ),
    )
    return c.json({ message })
  },
)

/**
 * 上传媒体消息（图片/语音）。
 * 原始二进制 body；query：?kind=image|voice&mime=...&duration=毫秒（语音必填）
 */
messageRoutes.post(
  '/api/classes/:id/messages/upload',
  authenticate,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const sender = await resolveSender(c, classId)
    if (!sender) return c.json({ error: '无权在该班级发送消息' }, 403)

    // 媒体上传是二进制 body：认领身份走 query 参数
    const actor_student_id = Number(c.req.query('actor') ?? 0) || undefined
    const kind = c.req.query('kind')
    if (kind !== 'image' && kind !== 'voice') {
      return c.json({ error: 'kind 必须为 image 或 voice' }, 400)
    }
    let actorName: string | null = null
    let actorId: number | null = null
    if (sender.role === 'student' && actor_student_id) {
      const stu = await c.env.DB
        .prepare('SELECT name FROM students WHERE id = ?1 AND class_id = ?2 AND active = 1')
        .bind(actor_student_id, classId)
        .first<{ name: string }>()
      if (!stu) return c.json({ error: '认领的学生不属于该班级' }, 400)
      actorName = stu.name
      actorId = actor_student_id
    }
    // 归一化：去掉 ;codecs=xxx 等附加段（浏览器录音常为 audio/webm;codecs=opus）
    const mime = (c.req.query('mime') ?? '').split(';')[0].trim().toLowerCase()
    if (!ALLOWED_MIME.includes(mime)) {
      return c.json({ error: `不支持的媒体类型 ${mime}` }, 400)
    }
    const durationRaw = Number(c.req.query('duration') ?? 0) || 0
    if (kind === 'voice' && (durationRaw < 100 || durationRaw > 65_000)) {
      return c.json({ error: '语音时长需在 0.1~65 秒' }, 400)
    }

    const buf = new Uint8Array(await c.req.arrayBuffer())
    if (buf.byteLength === 0) return c.json({ error: '媒体内容为空' }, 400)
    if (buf.byteLength > MAX_MEDIA_BYTES) {
      return c.json({ error: '媒体超过 400KB 上限（请压缩后重试）' }, 400)
    }

    const ins = await c.env.DB.prepare(
      `INSERT INTO messages (class_id, sender_role, actor_student_id, kind, body, media, media_mime, media_duration_ms, popup)
       VALUES (?1,?2,?3,?4,'',?5,?6,?7,?8)`,
    )
      .bind(
        classId,
        sender.role,
        actorId,
        kind,
        buf,
        mime,
        kind === 'voice' ? durationRaw : null,
        c.req.query('popup') === '0' ? 0 : 1,
      )
      .run()
    const id = ins.meta.last_row_id as number
    const created = await c.env.DB.prepare('SELECT created_at FROM messages WHERE id = ?')
      .bind(id)
      .first<{ created_at: string }>()

    const message = {
      id,
      class_id: classId,
      sender_role: sender.role,
      sender_name: actorName ?? (sender.role === 'student' ? '值日生' : '老师'),
      actor_student_id: actorId,
      kind,
      body: '',
      popup: c.req.query('popup') !== '0',
      has_media: true,
      media_mime: mime,
      media_duration_ms: kind === 'voice' ? durationRaw : null,
      created_at: created?.created_at ?? new Date().toISOString(),
    }
    await broadcast(c.env, classId, { type: 'message', message })
    // Web Push：媒体消息只提示类型，不预览内容
    sideTask(c, () =>
      pushClass(
        c.env,
        classId,
        {
          type: 'message',
          title:
            sender.role === 'teacher'
              ? '老师来消息了'
              : actorName
                ? `${actorName}来消息了`
                : '值日生来消息了',
          body: kind === 'image' ? '[图片]' : '[语音消息]',
        },
        senderDevice(c),
      ),
    )
    return c.json({ message })
  },
)

/** 删除消息（软删除）。发送者本人（按认领身份）或本班教师/管理员可删。 */
messageRoutes.delete(
  '/api/classes/:id/messages/:msgId',
  authenticate,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const user = c.get('user')!
    const msgId = Number(c.req.param('msgId'))
    const row = await c.env.DB
      .prepare('SELECT id, sender_role, actor_student_id FROM messages WHERE id = ?1 AND class_id = ?2')
      .bind(msgId, classId)
      .first<any>()
    if (!row) return c.json({ error: '消息不存在' }, 404)

    let allowed = false
    if (user.role === 'admin') {
      allowed = true
    } else if (user.role === 'teacher') {
      const ok = await c.env.DB
        .prepare(
          `SELECT 1 AS ok WHERE EXISTS (
           SELECT 1 FROM classes WHERE id = ?1 AND teacher_id = ?2
         ) OR EXISTS (
           SELECT 1 FROM class_teachers WHERE class_id = ?1 AND user_id = ?2
         )`,
        )
        .bind(classId, user.userId)
        .first()
      allowed = !!ok
    } else if (user.role === 'student') {
      // 学生只能删自己认领身份发的消息
      allowed = user.classId === classId && row.sender_role === 'student' && row.actor_student_id !== null
    }
    if (!allowed) return c.json({ error: '无权删除该消息' }, 403)

    await c.env.DB.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').bind(msgId).run()
    await broadcast(c.env, classId, { type: 'message-deleted', id: msgId })
    await broadcastRefresh(c.env, classId, 'messages')
    return c.json({ ok: true })
  },
)

/** 媒体取回（鉴权转发，不做公开直链）。支持 Authorization 头或 ?token=（img/audio 标签场景）。 */
messageRoutes.get(
  '/api/classes/:id/messages/media/:msgId',
  async (c) => {
    const classId = Number(c.req.param('id'))
    const token = bearerToken(c) || c.req.query('token') || ''
    const user = await sessionFromToken(c.env.DB, token)
    if (!user) return c.json({ error: '未登录' }, 401)
    const allowed =
      user.role === 'student'
        ? user.classId === classId
        : !!(await c.env.DB
            .prepare('SELECT 1 AS ok FROM classes WHERE id = ?1 AND teacher_id = ?2')
            .bind(classId, user.userId)
            .first())
    if (!allowed) return c.json({ error: '无权访问该班级消息' }, 403)
    const msgId = Number(c.req.param('msgId'))
    const row = await c.env.DB.prepare(
      'SELECT media, media_mime FROM messages WHERE id = ?1 AND class_id = ?2',
    )
      .bind(msgId, classId)
      .first<{ media: ArrayBuffer | Uint8Array; media_mime: string }>()
    if (!row?.media) return c.json({ error: '媒体不存在' }, 404)
    const bytes = row.media instanceof Uint8Array ? row.media : new Uint8Array(row.media)
    return c.body(new Blob([bytes], { type: row.media_mime }), 200, {
      'Content-Type': row.media_mime,
      'Cache-Control': 'private, max-age=31536000, immutable',
    })
  },
)

/**
 * WebSocket 实时通道（每班一个 DO）。
 * 连接：/api/classes/:id/messages/ws?token=<会话令牌>
 * 协议：服务端推 { type:'message', message }；客户端发 'ping' → 'pong'
 */
messageRoutes.get(
  '/api/classes/:id/messages/ws',
  async (c) => {
    const classId = Number(c.req.param('id'))
    const token = c.req.query('token') ?? ''
    if (!token) return c.json({ error: '缺少 token' }, 401)

    const row = await c.env.DB.prepare(
      `SELECT s.kind, s.class_id, s.expires_at, u.id AS uid, u.role
       FROM sessions s LEFT JOIN users u ON u.id = s.user_id
       WHERE s.token = ?1`,
    )
      .bind(token)
      .first<any>()
    if (!row) return c.json({ error: '会话无效' }, 401)
    if (new Date(row.expires_at).getTime() < Date.now()) return c.json({ error: '会话已过期' }, 401)

    // 班级归属校验：student 会话绑定班级；teacher 需为本班班主任
    let allowed = false
    if (row.kind === 'student') allowed = row.class_id === classId
    else if (row.role === 'teacher') {
      allowed = !!(await c.env.DB
        .prepare('SELECT 1 AS ok FROM classes WHERE id = ?1 AND teacher_id = ?2')
        .bind(classId, row.uid)
        .first())
    } else if (row.role === 'admin') {
      allowed = !!(await c.env.DB.prepare('SELECT 1 AS ok FROM classes WHERE id = ?1').bind(classId).first())
    }
    if (!allowed) return c.json({ error: '无权访问该班级消息' }, 403)

    if (!c.env.CHAT) return c.json({ error: '聊天通道未启用' }, 503)

    const id = c.env.CHAT.idFromName(`class-chat:${classId}`)
    const stub = c.env.CHAT.get(id)
    // 转发升级请求到 DO（保留 Upgrade 头）
    return stub.fetch(new Request('https://do/connect', request_cloneUpgrade(c)))
  },
)

/** 复制原始升级请求头（Workers 要求 Upgrade 请求原样带 Sec-WebSocket-* 头）。 */
function request_cloneUpgrade(c: any): RequestInit {
  const headers = new Headers()
  for (const key of [
    'upgrade',
    'connection',
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-protocol',
    'sec-websocket-extensions',
  ]) {
    const v = c.req.header(key)
    if (v) headers.set(key, v)
  }
  return { method: 'GET', headers }
}
