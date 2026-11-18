import { WebSocketServer } from 'ws'

/**
 * 聊天广播枢纽：替代 Cloudflare Durable Object 的 Node 版实现。
 * - 协议与线上完全一致：服务端推 {type:'message'|'refresh'|'message-deleted',...}，客户端 'ping' → 'pong'
 * - HTTP upgrade 直接在本进程完成（鉴权 → 入房）；Hono 的 WS 路由不再使用
 * - DO 垫片只实现 broadcast（realtime.ts 的唯一用途）
 */
export class ChatHub {
  /** classId → Set<ws> */
  rooms = new Map()
  wss = null
  /** 鉴权查询需要 D1 垫片（sessions/classes 表） */
  db = null

  attach(server) {
    this.wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost')
      const m = url.pathname.match(/^\/api\/classes\/(\d+)\/messages\/ws$/)
      if (!m) {
        socket.destroy()
        return
      }
      const classId = Number(m[1])
      const token = url.searchParams.get('token') ?? ''
      if (!this.authorize(classId, token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.join(classId, ws)
      })
    })
  }

  /** 与 messages.ts WS 路由同一套班级归属校验 */
  authorize(classId, token) {
    if (!token) return false
    const row = this.db
      .prepare(
        `SELECT s.kind, s.class_id, s.expires_at, u.id AS uid, u.role
         FROM sessions s LEFT JOIN users u ON u.id = s.user_id
         WHERE s.token = ?`,
      )
      .get(token)
    if (!row) return false
    if (new Date(row.expires_at).getTime() < Date.now()) return false
    if (row.kind === 'student') return row.class_id === classId
    if (row.role === 'admin') return true
    if (row.role === 'teacher') {
      return !!this.db
        .prepare('SELECT 1 AS ok FROM classes WHERE id = ? AND teacher_id = ?')
        .get(classId, row.uid)
    }
    return false
  }

  join(classId, ws) {
    if (!this.rooms.has(classId)) this.rooms.set(classId, new Set())
    this.rooms.get(classId).add(ws)
    ws.on('message', (data) => {
      if (String(data) === 'ping') {
        try {
          ws.send('pong')
        } catch {
          /* 连接已关闭 */
        }
      }
    })
    ws.on('close', () => {
      this.rooms.get(classId)?.delete(ws)
      if (!this.rooms.get(classId)?.size) this.rooms.delete(classId)
    })
    ws.on('error', () => {
      this.rooms.get(classId)?.delete(ws)
    })
  }

  broadcast(classId, payload) {
    const room = this.rooms.get(classId)
    if (!room?.size) return
    const text = JSON.stringify(payload)
    for (const ws of room) {
      if (ws.readyState === 1 /* OPEN */) {
        try {
          ws.send(text)
        } catch {
          /* 单个失败不影响其他 */
        }
      }
    }
  }

  /** 在线连接数（健康检查展示用） */
  get onlineCount() {
    let n = 0
    for (const room of this.rooms.values()) n += room.size
    return n
  }
}

/** Env.CHAT 垫片：realtime.ts 的 broadcast(env, classId, payload) 走这里 */
export function makeChatBinding(hub) {
  return {
    idFromName: (name) => {
      const m = String(name).match(/^class-chat:(\d+)$/)
      return { classId: m ? Number(m[1]) : 0 }
    },
    get: (id) => ({
      fetch: async (url, init) => {
        if (String(url).includes('/broadcast')) {
          const text = typeof init?.body === 'string' ? init.body : await new Response(init?.body).text()
          try {
            hub.broadcast(id.classId, JSON.parse(text))
          } catch {
            /* 广播失败不影响数据落库；客户端有增量拉取兜底 */
          }
        }
        return new Response('ok')
      },
    }),
  }
}
