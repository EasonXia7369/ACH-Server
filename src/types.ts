export interface Env {
  DB: D1Database
  /** 班级聊天 DO（测试环境缺失，消息路由需容忍其缺失） */
  CHAT?: DurableObjectNamespace
  ARK_BOOTSTRAP_CODE?: string
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
