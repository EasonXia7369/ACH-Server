import type { Env } from './types.js'

/**
 * AI 调用底座：自配 OpenAI 兼容接口优先，Workers AI binding 兜底。
 * 未配置（无 AI_API_KEY 且无 AI binding）→ aiEnabled=false，功能整体隐藏。
 * 所有学生统计类数据出域前必须已脱敏（maskName）；唯一例外是成绩智能导入（用户拍板明文直发）。
 */

const DEFAULT_WORKERS_AI_MODEL = '@cf/qwen/qwen2.5-7b-instruct'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TOKENS = 700

export class AiError extends Error {}

export function aiEnabled(env: Env): boolean {
  return !!(env.AI_API_KEY && env.AI_BASE_URL) || !!env.AI
}

interface AiOpts {
  maxTokens?: number
  timeoutMs?: number
  /** OpenAI 兼容模式下覆盖默认模型名 */
  model?: string
}

interface AiMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 200)
      } catch {
        /* ignore */
      }
      throw new AiError(`AI 服务返回 ${res.status}${detail ? `：${detail}` : ''}`)
    }
    return await res.json()
  } catch (e: any) {
    if (e instanceof AiError) throw e
    if (e?.name === 'AbortError') throw new AiError('AI 请求超时')
    throw new AiError(`AI 请求失败：${e?.message ?? e}`)
  } finally {
    clearTimeout(timer)
  }
}

/** 单轮补全：system + user → 文本。 */
export async function aiComplete(env: Env, system: string, user: string, opts?: AiOpts): Promise<string> {
  const messages: AiMsg[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // 1) 自配 OpenAI 兼容接口
  if (env.AI_API_KEY && env.AI_BASE_URL) {
    const base = env.AI_BASE_URL.replace(/\/+$/, '')
    const data = await fetchJson(
      `${base}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AI_API_KEY}` },
        body: JSON.stringify({
          model: opts?.model ?? env.AI_MODEL ?? 'deepseek-chat',
          messages,
          max_tokens: maxTokens,
          temperature: 0.5,
        }),
      },
      timeoutMs,
    )
    const text = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) throw new AiError('AI 未返回内容')
    return text.trim()
  }

  // 2) Workers AI 兜底
  if (env.AI) {
    const out = (await env.AI.run(DEFAULT_WORKERS_AI_MODEL, {
      messages,
      max_tokens: maxTokens,
    })) as unknown
    const text =
      (out as any)?.response ?? (out as any)?.result?.response ?? (typeof out === 'string' ? out : '')
    if (typeof text !== 'string' || !text.trim()) throw new AiError('AI 未返回内容')
    return text.trim()
  }

  throw new AiError('AI 未配置')
}

/** 从 LLM 文本中提取 JSON（容忍 ```json 代码块与前后杂文），失败返回 null。 */
export function extractJson<T = any>(text: string): T | null {
  const candidates: string[] = []
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) candidates.push(fence[1])
  candidates.push(text)
  for (const cand of candidates) {
    const start = cand.search(/[{[]/)
    if (start === -1) continue
    const end = Math.max(cand.lastIndexOf('}'), cand.lastIndexOf(']'))
    if (end <= start) continue
    try {
      return JSON.parse(cand.slice(start, end + 1)) as T
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return null
}
