import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/**
 * D1 垫片：以 better-sqlite3 实现 D1 最小接口（与 test/helpers.ts 同语义，文件持久化版）。
 * 语义差异已按 D1 处理：batch 事务执行；?N 编号占位符转换为匿名 ? 并重排参数。
 */

export function openDatabase(dbFile) {
  const db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  return db
}

export function createD1(db) {
  function translate(sql, params) {
    const perm = []
    const newSql = sql.replace(/\?(\d+)/g, (_, n) => {
      perm.push(Number(n) - 1)
      return '?'
    })
    const ordered = perm.length ? perm.map((i) => params[i]) : params
    return { newSql, ordered }
  }

  function makeStmt(sql, params) {
    const { newSql, ordered } = translate(sql, params)
    const stmt = db.prepare(newSql)
    return {
      bind: (...more) => makeStmt(sql, [...params, ...more]),
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

  return {
    prepare: (sql) => makeStmt(sql, []),
    batch: async (stmts) => {
      const tx = db.transaction((items) => items.map((s) => s._exec()))
      return tx(stmts)
    },
    exec: async (sql) => {
      db.exec(sql)
    },
  }
}

/** 启动时应用 migrations/*.sql（记录在 d1_migrations 表，幂等） */
export function applyMigrations(db, migrationsDir, log = console.log) {
  db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
  const applied = new Set(
    db.prepare('SELECT name FROM d1_migrations').all().map((r) => r.name),
  )
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  const record = db.prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)')
  for (const f of files) {
    if (applied.has(f)) continue
    db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
    record.run(f, new Date().toISOString())
    log(`已应用迁移 ${f}`)
  }
}
