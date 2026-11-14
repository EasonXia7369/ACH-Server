import type { AppContext } from './types.js'

/**
 * 班级聊天 DO：每个班级一个实例（class-chat:{classId}）。
 * 职责：持有班级内所有 WebSocket 连接（老师 + 值日生），广播新消息。
 * 消息持久化在 D1（由 HTTP 路由负责写入后调 broadcast），DO 只做实时分发。
 *
 * 使用 WebSocket Hibernation API：空闲连接不计费，适合教室常驻大屏。
 */
export class ClassChatDO {
  private state: DurableObjectState

  constructor(state: DurableObjectState, _env: AppContext['Bindings']) {
    this.state = state
  }

  /** HTTP 入口：/connect（WS 升级，转发自 Worker）与 /broadcast（Worker 内部调用）。 */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname.endsWith('/broadcast')) {
      const payload = await request.text()
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(payload)
        } catch {
          // 单个连接失败不影响广播其余连接（断线会被 hibernation close 事件清理）
        }
      }
      return new Response('ok')
    }

    if (url.pathname.endsWith('/connect')) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('expected websocket', { status: 400 })
      }
      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1])
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    return new Response('not found', { status: 404 })
  }

  /** 客户端心跳（保持连接活性感知）；不承担业务逻辑。 */
  webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === 'string' && message === 'ping') {
      try {
        _ws.send('pong')
      } catch {
        // ignore
      }
    }
  }

  webSocketClose(_ws: WebSocket): void {
    // Hibernation API 自动清理，无需手动管理
  }
}
