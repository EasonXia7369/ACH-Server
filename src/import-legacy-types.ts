/** tools/export-legacy.html 导出的旧系统数据结构 */
export interface LegacyExport {
  app: string
  version: number
  exportedAt?: string
  syncCode: string
  names: string[]
  py?: Record<string, string>
  settings?: {
    class_name?: string
    pass_hash?: string | null
    student_pass_hash?: string | null
    subjects?: string[]
  }
  attendance: Array<{
    day: string
    payload: Record<string, Record<string, { status: string; note?: string }>>
    updated_at?: string
  }>
  hwRecords: Array<{
    day: string
    subject: string
    title?: string
    missing: string[]
    deleted?: boolean
    updated_at?: string
  }>
  hwTasks: Array<{
    day: string
    subject: string
    content?: string
    deleted?: boolean
    updated_at?: string
  }>
  logs: Array<{ ts: string; usr?: string; action: string; detail?: string }>
}
