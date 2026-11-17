import { Hono } from 'hono'
import type { AppContext } from '../types.js'
import { authenticate } from '../auth.js'
import { pushEnabled } from '../push.js'

export const pushRoutes = new Hono<AppContext>()

/**
 * 订阅信息：{ enabled, publicKey }
 * enabled=false 表示服务端未配置 VAPID 密钥，前端隐藏推送入口。
 */
pushRoutes.get('/api/push/config', authenticate, (c) => {
  const enabled = pushEnabled(c.env)
  return c.json({
    enabled,
    publicKey: enabled ? (c.env as any).VAPID_PUBLIC_KEY : null,
  })
})

/**
 * 保存/更新设备订阅。body: { endpoint, keys: { p256dh, auth }, device_id }
 * - student 会话：订阅绑定班级（只收本班推送）
 * - teacher/admin 会话：订阅跟随用户（收其全部班级推送）
 * 同一浏览器只有一个 endpoint，重复订阅走 UPSERT。
 */
pushRoutes.post('/api/push/subscribe', authenticate, async (c) => {
  const user = c.get('user')!
  const { endpoint, keys, device_id } = await c.req.json<{
    endpoint?: string
    keys?: { p256dh?: string; auth?: string }
    device_id?: string
  }>()
  if (!endpoint || !keys?.p256dh || !keys.auth) {
    return c.json({ error: '订阅参数不完整' }, 400)
  }
  const now = new Date().toISOString()
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (class_id, role, user_id, device_id, endpoint, p256dh, auth, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
     ON CONFLICT(endpoint) DO UPDATE SET
       class_id = excluded.class_id, role = excluded.role, user_id = excluded.user_id,
       device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth,
       updated_at = excluded.updated_at`,
  )
    .bind(
      user.role === 'student' ? (user.classId ?? null) : null,
      user.role,
      user.role === 'student' ? null : user.userId,
      (device_id ?? '').slice(0, 64),
      endpoint,
      keys.p256dh,
      keys.auth,
      now,
    )
    .run()
  return c.json({ ok: true })
})

/** 注销订阅。body: { endpoint } */
pushRoutes.post('/api/push/unsubscribe', authenticate, async (c) => {
  const { endpoint } = await c.req.json<{ endpoint?: string }>()
  if (!endpoint) return c.json({ error: '缺少 endpoint' }, 400)
  await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run()
  return c.json({ ok: true })
})
