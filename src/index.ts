import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppContext, Env } from './types.js'
import { authRoutes } from './routes/auth.js'
import { classRoutes } from './routes/classes.js'
import { adminRoutes } from './routes/admin.js'
import { attendanceRoutes } from './routes/attendance.js'
import { leaveRoutes } from './routes/leaves.js'
import { auditRoutes } from './routes/audit.js'
import { homeworkRoutes } from './routes/homework.js'
import { dutyRoutes } from './routes/duty.js'
import { kioskRoutes } from './routes/kiosk.js'
import { messageRoutes } from './routes/messages.js'

/** 允许的前端来源：生产 Pages 域名 + 本地 Vite 开发服务器 */
const ALLOWED_ORIGINS = ['https://ach.macrostar.top', 'http://localhost:5173']

export function createApp() {
  const app = new Hono<AppContext>()

  // 前后端分离：API 独立域名，需要 CORS（Bearer token 鉴权，无需 credentials）
  app.use(
    '/api/*',
    cors({
      origin: ALLOWED_ORIGINS,
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      maxAge: 86400,
    }),
  )

  app.get('/api/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }))
  app.route('/', authRoutes)
  app.route('/', classRoutes)
  app.route('/', adminRoutes)
  app.route('/', attendanceRoutes)
  app.route('/', leaveRoutes)
  app.route('/', auditRoutes)
  app.route('/', homeworkRoutes)
  app.route('/', dutyRoutes)
  app.route('/', kioskRoutes)
  app.route('/', messageRoutes)

  app.notFound((c) => c.json({ error: '接口不存在' }, 404))

  return app
}

const app = createApp()

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx)
  },
}

// wrangler 要求 DO 类从 main 导出
export { ClassChatDO } from './chat-do.js'
