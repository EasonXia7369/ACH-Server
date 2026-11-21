import type { Env } from './types.js'

/**
 * AI 调用底座：自配 OpenAI 兼容接口优先，Workers AI binding 兜底。
 * 配置优先级：数据库 settings（管理页「AI 设置」）> 部署级 Env（wrangler secret / config.json）。
 * 未配置（两处都没有）→ 功能整体隐藏。
 * 所有学生统计类数据出域前必须已脱敏（maskName）；唯一例外是成绩智能导入（用户拍板明文直发）。
 */

const DEFAULT_WORKERS_AI_MODEL = '@cf/qwen/qwen2.5-7b-instruct'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TOKENS = 700

export class AiError extends Error {}

export interface AiRuntimeConfig {
  kind: 'custom' | 'workers' | 'none'
  apiKey?: string
  baseUrl?: string
  model?: string
  /** 配置来源：db（管理页）/ env（部署级）/ builtin（Workers AI） */
  source?: string
}

/**
 * 解析当前生效的 AI 配置：数据库 settings['ai'] 优先，其次 Env。
 * db 可省略（省略时不查库，仅用 Env）。
 */
export async function resolveAiConfig(env: Env, db?: D1Database): Promise<AiRuntimeConfig> {
  if (db) {
    try {
      const row = await db.prepare('SELECT value FROM settings WHERE key = ?1').bind('ai').first<{ value: string }>()
      if (row) {
        const cfg = JSON.parse(row.value) as { apiKey?: string; baseUrl?: string; model?: string }
        if (cfg.apiKey && cfg.baseUrl) {
          return { kind: 'custom', apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model, source: 'db' }
        }
      }
    } catch {
      /* settings 表异常时回落 Env */
    }
  }
  if (env.AI_API_KEY && env.AI_BASE_URL) {
    return { kind: 'custom', apiKey: env.AI_API_KEY, baseUrl: env.AI_BASE_URL, model: env.AI_MODEL, source: 'env' }
  }
  if (env.AI) return { kind: 'workers', source: 'builtin' }
  return { kind: 'none' }
}

export interface AiOpts {
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

/** 用解析出的配置执行单轮补全（test 接口可传入任意配置验证连通性）。 */
export async function aiCompleteWith(
  cfg: AiRuntimeConfig,
  system: string,
  user: string,
  opts?: AiOpts,
): Promise<string> {
  if (cfg.kind === 'none') throw new AiError('AI 未配置')
  const messages: AiMsg[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (cfg.kind === 'custom') {
    const base = (cfg.baseUrl ?? '').replace(/\/+$/, '')
    const data = await fetchJson(
      `${base}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: opts?.model ?? cfg.model ?? 'deepseek-chat',
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

  // Workers AI 兜底（cfg.binding 由 aiComplete 注入 env.AI）
  const binding = (cfg as any).binding
  if (!binding) throw new AiError('AI 未配置')
  const out = (await binding.run(DEFAULT_WORKERS_AI_MODEL, {
    messages,
    max_tokens: maxTokens,
  })) as unknown
  const text = (out as any)?.response ?? (out as any)?.result?.response ?? (typeof out === 'string' ? out : '')
  if (typeof text !== 'string' || !text.trim()) throw new AiError('AI 未返回内容')
  return text.trim()
}

/** 便捷入口：自动解析配置后补全。 */
export async function aiComplete(
  env: Env,
  db: D1Database | undefined,
  system: string,
  user: string,
  opts?: AiOpts,
): Promise<string> {
  const cfg = await resolveAiConfig(env, db)
  if (cfg.kind === 'workers') {
    ;(cfg as any).binding = env.AI
  }
  return aiCompleteWith(cfg, system, user, opts)
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
