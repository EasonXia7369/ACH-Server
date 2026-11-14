export interface Env {
  DB: D1Database
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
