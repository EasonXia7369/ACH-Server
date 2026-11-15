import type { Env } from './types.js'

/**
 * 实时广播辅助：消息之外的数据变更（作业/考勤/值日/请假）
 * 通过班级聊天 DO 广播刷新信号，让所有在线设备自动重拉数据。
 */

export function chatStub(env: Env, classId: number): DurableObjectStub | null {
  if (!env.CHAT) return null
  const id = env.CHAT.idFromName(`class-chat:${classId}`)
  return env.CHAT.get(id)
}

export async function broadcast(env: Env, classId: number, payload: unknown): Promise<void> {
  const stub = chatStub(env, classId)
  if (!stub) return
  try {
    await stub.fetch('https://do/broadcast', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  } catch {
    // 广播失败不影响数据落库；客户端有增量拉取兜底
  }
}

/** 通知全班：某类数据发生变更，客户端收到后重拉对应板块。 */
export async function broadcastRefresh(
  env: Env,
  classId: number,
  scope: 'tasks' | 'records' | 'attendance' | 'duty' | 'leaves',
  day?: string,
): Promise<void> {
  await broadcast(env, classId, { type: 'refresh', scope, day })
}
