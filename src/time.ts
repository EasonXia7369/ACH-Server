/**
 * SQLite datetime('now') 写入的是 UTC 无时区串（YYYY-MM-DD HH:MM:SS）。
 * 前端 dayjs 按本地时间解析这种串会偏移时区，出参统一转成带 Z 的 ISO。
 */
export function isoTs(v: string | null | undefined): string {
  if (!v) return new Date().toISOString()
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? v.replace(' ', 'T') + 'Z' : v
}
