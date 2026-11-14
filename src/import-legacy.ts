import type { LegacyExport } from './import-legacy-types.js'

/**
 * 将旧 demo 导出 JSON 导入为新班级 + 全量数据。
 * 旧 sid 为 `s<序号>`，与 names 数组下标一一对应。
 * D1 无交互式事务：所有写入收集为 batch（D1 batch 原子执行）。
 */
export async function importLegacy(
  db: D1Database,
  data: LegacyExport,
  adminUserId: number,
): Promise<{
  classId: number
  studentCount: number
  attendanceRows: number
  hwRecordRows: number
  hwTaskRows: number
  logRows: number
}> {
  const dup = await db.prepare('SELECT 1 AS ok FROM classes WHERE legacy_sync_code = ?1')
    .bind(data.syncCode)
    .first()
  if (dup) throw new Error(`同步码 ${data.syncCode} 的数据已导入过，请勿重复导入`)
  if (!Array.isArray(data.names) || data.names.length === 0) {
    throw new Error('名单为空')
  }

  const stmts: D1PreparedStatement[] = []
  const now = new Date().toISOString()

  const clsIns = await db
    .prepare(
      'INSERT INTO classes (name, grade, teacher_id, legacy_sync_code) VALUES (?1,?2,?3,?4)',
    )
    .bind(
      data.settings?.class_name?.trim() || `班级${data.syncCode}`,
      '',
      adminUserId,
      data.syncCode,
    )
    .run()
  const classId = clsIns.meta.last_row_id as number

  if (data.settings?.subjects?.length) {
    stmts.push(
      db.prepare('UPDATE classes SET subjects_json = ?2 WHERE id = ?1').bind(
        classId,
        JSON.stringify(data.settings.subjects.slice(0, 30)),
      ),
    )
  }

  // 旧学生密码 hash：保留 legacy-sha256 前缀，一体机登录时兼容校验
  if (data.settings?.student_pass_hash) {
    stmts.push(
      db
        .prepare('UPDATE classes SET student_pass_hash = ?2 WHERE id = ?1')
        .bind(classId, `legacy-sha256:${data.syncCode}:${data.settings.student_pass_hash}`),
    )
  }

  const insertStudent = db.prepare(
    'INSERT INTO students (class_id, name, seq, pinyin_initial) VALUES (?1,?2,?3,?4)',
  )
  const sidToStudentId = new Map<string, number>()
  let seq = 0
  for (const name of data.names) {
    seq++
    const sid = `s${seq}`
    const initial = (data.py?.[name.charAt(0)] ?? name.charAt(0)).toUpperCase()
    // 先建班拿到 classId，学生逐条插入（需要回读 id）
    const ins = await insertStudent.bind(classId, name, seq, initial).run()
    sidToStudentId.set(sid, ins.meta.last_row_id as number)
  }

  // 考勤：旧模型「出勤不落盘」，导入时保持一致
  let attendanceRows = 0
  for (const row of data.attendance ?? []) {
    for (const [sid, slots] of Object.entries(row.payload ?? {})) {
      const studentId = sidToStudentId.get(sid)
      if (!studentId) continue
      for (const slot of ['morning', 'noon', 'evening'] as const) {
        const cell = slots[slot]
        if (!cell?.status || cell.status === 'present') continue
        stmts.push(
          db
            .prepare(
              `INSERT INTO attendance (class_id, day, student_id, slot, status, note, updated_by_role, updated_at)
               VALUES (?1,?2,?3,?4,?5,?6,'teacher',?7)`,
            )
            .bind(classId, row.day, studentId, slot, cell.status, cell.note ?? '', row.updated_at ?? now),
        )
        attendanceRows++
      }
    }
  }

  let hwRecordRows = 0
  for (const r of data.hwRecords ?? []) {
    const missing = (r.missing ?? [])
      .map((sid) => sidToStudentId.get(sid))
      .filter((v): v is number => v !== undefined)
    stmts.push(
      db
        .prepare(
          `INSERT INTO homework_records (class_id, day, subject, title, missing_json, deleted, updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7)`,
        )
        .bind(classId, r.day, r.subject, r.title ?? '', JSON.stringify(missing), r.deleted ? 1 : 0, r.updated_at ?? now),
    )
    hwRecordRows++
  }

  let hwTaskRows = 0
  for (const t of data.hwTasks ?? []) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO homework_tasks (class_id, day, subject, content, deleted, updated_at)
           VALUES (?1,?2,?3,?4,?5,?6)`,
        )
        .bind(classId, t.day, t.subject, t.content ?? '', t.deleted ? 1 : 0, t.updated_at ?? now),
    )
    hwTaskRows++
  }

  let logRows = 0
  for (const log of data.logs ?? []) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO audit_logs (class_id, ts, actor, actor_id, action, detail)
           VALUES (?1,?2,?3,?4,?5,?6)`,
        )
        .bind(
          classId,
          log.ts,
          log.usr === '学生' ? 'student' : 'teacher',
          log.usr === '学生' ? null : adminUserId,
          log.action,
          log.detail ?? '',
        ),
    )
    logRows++
  }

  if (stmts.length) await db.batch(stmts)

  return { classId, studentCount: data.names.length, attendanceRows, hwRecordRows, hwTaskRows, logRows }
}
