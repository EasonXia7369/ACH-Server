export interface Env {
  DB: D1Database
  /** 班级聊天 DO（测试环境缺失，消息路由需容忍其缺失） */
  CHAT?: DurableObjectNamespace
  ARK_BOOTSTRAP_CODE?: string
  /** Web Push VAPID（wrangler secret / .dev.vars；未配置时推送关闭） */
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
}

export interface SessionUser {
  userId: number
  role: 'teacher' | 'admin' | 'student'
  name: string
  /** student 会话绑定班级 */
  classId?: number
}

export type AppContext = {
  Bindings: Env
  Variables: { user?: SessionUser }
}
