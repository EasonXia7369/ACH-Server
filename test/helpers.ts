import { readdirSync, readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { createApp } from '../src/index.js'

/**
 * 测试用 D1 适配层：以 better-sqlite3（内存库）实现 D1 的最小接口。
 * 运行时与 D1 的差异（如 batch 原子性）按 D1 语义模拟；接口调用均为 async。
 */
export function createD1Shim(db: Database.Database): D1Database {
  /** better-sqlite3 不支持 `?N` 编号占位符（D1 支持）：转换为匿名 `?` 并重排参数 */
  function translate(sql: string, params: any[]) {
    const perm: number[] = []
    const newSql = sql.replace(/\?(\d+)/g, (_, n) => {
      perm.push(Number(n) - 1)
      return '?'
    })
    const ordered = perm.length ? perm.map((i) => params[i]) : params
    return { newSql, ordered }
  }

  function makeStmt(sql: string, params: any[]): any {
    const { newSql, ordered } = translate(sql, params)
    const stmt = db.prepare(newSql)
    return {
      bind: (...more: any[]) => makeStmt(sql, [...params, ...more]),
      first: async () => stmt.get(...ordered) ?? null,
      all: async () => ({ results: stmt.all(...ordered) }),
      run: async () => {
        const info = stmt.run(...ordered)
        return {
          success: true,
          meta: { last_row_id: Number(info.lastInsertRowid), changes: info.changes },
        }
      },
      _exec: () => {
        const info = stmt.run(...ordered)
        return { last_row_id: Number(info.lastInsertRowid), changes: info.changes }
      },
    }
  }

  const shim: any = {
    prepare: (sql: string) => makeStmt(sql, []),
    batch: async (stmts: any[]) => {
      // D1 batch 原子执行
      const tx = db.transaction((items: any[]) => items.map((s) => s._exec()))
      return tx(stmts)
    },
    exec: async (sql: string) => {
      db.exec(sql)
    },
  }
  return shim as unknown as D1Database
}

export interface InjectResult {
  statusCode: number
  json: () => any
}

export interface TestCtx {
  inject: (opts: {
    method: string
    url: string
    payload?: any
    headers?: Record<string, string>
  }) => Promise<InjectResult>
  /** 原始二进制请求（媒体上传用），返回 Response */
  rawRequest: (
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: ArrayBuffer | Uint8Array,
  ) => Promise<Response>
  /** 直接查询内存库（与 better-sqlite3 同步接口） */
  db: Database.Database
}

/** 创建独立的测试上下文：内存库 + 全部迁移 + Hono app。每个测试文件一个，互不影响。 */
export function createTestCtx(bootstrapCode = 'TESTBOOT'): TestCtx {
  const db = new Database(':memory:')
  for (const f of readdirSync(new URL('../migrations', import.meta.url)).sort()) {
    if (f.endsWith('.sql')) {
      db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
    }
  }
  // 测试环境没有 CHAT DO 绑定：消息路由需容忍其缺失（跳过广播）
  const env = { DB: createD1Shim(db), ARK_BOOTSTRAP_CODE: bootstrapCode }
  const app = createApp()

  const inject = async ({
    method,
    url,
    payload,
    headers,
  }: {
    method: string
    url: string
    payload?: any
    headers?: Record<string, string>
  }): Promise<InjectResult> => {
    const init: RequestInit = { method, headers }
    if (payload !== undefined) {
      init.body = JSON.stringify(payload)
      init.headers = { ...headers, 'Content-Type': 'application/json' }
    }
    const res = await app.request(url, init, env as any)
    const data = await res.json().catch(() => ({}))
    return { statusCode: res.status, json: () => data }
  }

  const rawRequest = async (
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: ArrayBuffer | Uint8Array,
  ): Promise<Response> => {
    const init: RequestInit = { method, headers }
    if (body !== undefined) init.body = body as any
    return app.request(url, init, env as any)
  }

  return { inject, rawRequest, db }
}
