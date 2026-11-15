import { Hono, type MiddlewareHandler } from 'hono'
import type { AppContext } from '../types.js'
import {
  authenticate,
  canAccessClass,
  createSession,
  hashStudentPassword,
  requireRole,
  verifyPassword,
} from '../auth.js'
import { audit } from '../audit.js'

export const classRoutes = new Hono<AppContext>()

type MH = MiddlewareHandler<AppContext>

/** teacher/admin 权限 + 班级归属校验（student 仅限本人绑定班级）。 */
const teacherGuard: MH = async (c, next) => {
  const classId = Number(c.req.param('id'))
  const user = c.get('user')!
  if (await canAccessClass(c.env.DB, user, classId)) return next()
  return c.json({ error: '无权操作该班级' }, 403)
}

const readGuard: MH = async (c, next) => {
  const classId = Number(c.req.param('id'))
  const user = c.get('user')
  if (user && (await canAccessClass(c.env.DB, user, classId))) return next()
  return c.json({ error: '无权访问该班级' }, 403)
}

const teacher: [MH, MH, MH] = [authenticate, requireRole('teacher', 'admin'), teacherGuard]
const reader: [MH, MH, MH] = [authenticate, requireRole('teacher', 'admin', 'student'), readGuard]

classRoutes.get(
  '/api/classes',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    const user = c.get('user')!
    const rows =
      user.role === 'admin'
        ? (
            await c.env.DB.prepare(
              `SELECT c.*, u.name AS teacher_name,
                      (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND s.active = 1) AS student_count
               FROM classes c JOIN users u ON u.id = c.teacher_id ORDER BY c.id`,
            ).all<any>()
          ).results
        : (
            await c.env.DB.prepare(
              `SELECT c.*, u.name AS teacher_name,
                      (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND s.active = 1) AS student_count
               FROM classes c JOIN users u ON u.id = c.teacher_id
               WHERE c.teacher_id = ?1 ORDER BY c.id`,
            )
              .bind(user.userId)
              .all<any>()
          ).results
    return c.json({ classes: rows.map((r) => ({ ...r, subjects: JSON.parse(r.subjects_json) })) })
  },
)

classRoutes.post('/api/classes', authenticate, requireRole('teacher', 'admin'), async (c) => {
  const { name, grade } = await c.req.json<{ name?: string; grade?: string }>()
  if (!name?.trim()) return c.json({ error: '班级名称不能为空' }, 400)
  const ins = await c.env.DB.prepare('INSERT INTO classes (name, grade, teacher_id) VALUES (?,?,?)')
    .bind(name.trim(), grade?.trim() ?? '', c.get('user')!.userId)
    .run()
  const cls = await c.env.DB.prepare('SELECT * FROM classes WHERE id = ?')
    .bind(ins.meta.last_row_id as number)
    .first<any>()
  return c.json({ class: { ...cls, subjects: JSON.parse(cls.subjects_json) } })
})

/** 重命名班级 / 修改年级。 */
classRoutes.put('/api/classes/:id', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const cls = await c.env.DB.prepare('SELECT * FROM classes WHERE id = ?').bind(classId).first<any>()
  if (!cls) return c.json({ error: '班级不存在' }, 404)
  const { name, grade } = await c.req.json<{ name?: string; grade?: string }>()
  if (name !== undefined && !name.trim()) return c.json({ error: '班级名称不能为空' }, 400)
  await c.env.DB.prepare('UPDATE classes SET name = ?, grade = ? WHERE id = ?')
    .bind(name?.trim() ?? cls.name, grade?.trim() ?? cls.grade, classId)
    .run()
  const updated = await c.env.DB.prepare('SELECT * FROM classes WHERE id = ?').bind(classId).first()
  return c.json({ class: updated })
})

classRoutes.get('/api/classes/:id', ...reader, async (c) => {
  const cls = await c.env.DB.prepare(
    `SELECT c.*, u.name AS teacher_name FROM classes c
     JOIN users u ON u.id = c.teacher_id WHERE c.id = ?`,
  )
    .bind(Number(c.req.param('id')))
    .first<any>()
  if (!cls) return c.json({ error: '班级不存在' }, 404)
  const students = (
    await c.env.DB.prepare(
      'SELECT id, name, seq, pinyin_initial, active FROM students WHERE class_id = ? ORDER BY seq',
    )
      .bind(cls.id)
      .all<any>()
  ).results
  return c.json({ class: { ...cls, subjects: JSON.parse(cls.subjects_json) }, students })
})

classRoutes.post('/api/classes/:id/students', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const { name, pinyin_initial } = await c.req.json<{ name?: string; pinyin_initial?: string }>()
  if (!name?.trim()) return c.json({ error: '姓名不能为空' }, 400)
  const max = await c.env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM students WHERE class_id = ?')
    .bind(classId)
    .first<{ m: number }>()
  const ins = await c.env.DB.prepare(
    'INSERT INTO students (class_id, name, seq, pinyin_initial) VALUES (?,?,?,?)',
  )
    .bind(classId, name.trim(), (max?.m ?? 0) + 1, (pinyin_initial ?? name.trim().charAt(0)).toUpperCase())
    .run()
  const stu = await c.env.DB.prepare('SELECT * FROM students WHERE id = ?')
    .bind(ins.meta.last_row_id as number)
    .first()
  return c.json({ student: stu })
})

/** 批量导入名单：跳过班内已有的同名学生，学号顺延。body: { students: [{ name, pinyin_initial? }] } */
classRoutes.post('/api/classes/:id/students/bulk', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const { students } = await c.req.json<{
    students?: Array<{ name?: string; pinyin_initial?: string }>
  }>()
  if (!Array.isArray(students) || students.length === 0) {
    return c.json({ error: '名单不能为空' }, 400)
  }
  if (students.length > 300) return c.json({ error: '单次最多导入 300 人' }, 400)

  const existingRows = (
    await c.env.DB.prepare('SELECT name FROM students WHERE class_id = ?1').bind(classId).all<any>()
  ).results
  const existing = new Set(existingRows.map((r) => r.name))
  const max = await c.env.DB
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM students WHERE class_id = ?')
    .bind(classId)
    .first<{ m: number }>()

  const seen = new Set<string>()
  const skipped: string[] = []
  const toAdd: Array<{ name: string; initial: string }> = []
  for (const s of students) {
    const name = (s?.name ?? '').trim().slice(0, 20)
    if (!name) continue
    if (existing.has(name) || seen.has(name)) {
      skipped.push(name)
      continue
    }
    seen.add(name)
    toAdd.push({
      name,
      initial: (s?.pinyin_initial ?? name.charAt(0)).toUpperCase(),
    })
  }

  if (toAdd.length) {
    let seq = max?.m ?? 0
    await c.env.DB.batch(
      toAdd.map((t) =>
        c.env.DB
          .prepare('INSERT INTO students (class_id, name, seq, pinyin_initial) VALUES (?,?,?,?)')
          .bind(classId, t.name, ++seq, t.initial),
      ),
    )
  }

  audit(
    c.env.DB,
    classId,
    'teacher',
    c.get('user')!.userId,
    '批量导入名单',
    `新增 ${toAdd.length} 人${skipped.length ? `，跳过重复 ${skipped.length} 人` : ''}`,
  ).run()

  return c.json({
    added: toAdd.length,
    added_names: toAdd.map((t) => t.name),
    skipped,
    total: existing.size + toAdd.length,
  })
})

classRoutes.put('/api/classes/:id/students/:sid', ...teacher, async (c) => {
  const sid = Number(c.req.param('sid'))
  const stu = await c.env.DB.prepare('SELECT * FROM students WHERE id = ? AND class_id = ?')
    .bind(sid, Number(c.req.param('id')))
    .first<any>()
  if (!stu) return c.json({ error: '学生不存在' }, 404)
  const { name, active } = await c.req.json<{ name?: string; active?: boolean }>()
  await c.env.DB.prepare('UPDATE students SET name = ?, active = ?, updated_at = ? WHERE id = ?')
    .bind(name?.trim() ?? stu.name, active === undefined ? stu.active : active ? 1 : 0, new Date().toISOString(), sid)
    .run()
  const updated = await c.env.DB.prepare('SELECT * FROM students WHERE id = ?').bind(sid).first()
  return c.json({ student: updated })
})

classRoutes.put('/api/classes/:id/subjects', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const { subjects } = await c.req.json<{ subjects?: string[] }>()
  if (!Array.isArray(subjects) || subjects.some((s) => !s?.trim())) {
    return c.json({ error: '科目格式错误' }, 400)
  }
  await c.env.DB.prepare('UPDATE classes SET subjects_json = ? WHERE id = ?')
    .bind(JSON.stringify(subjects.map((s) => s.trim().slice(0, 8))), classId)
    .run()
  return c.json({ subjects })
})

classRoutes.put('/api/classes/:id/student-pass', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const { password } = await c.req.json<{ password?: string | null }>()
  const cls = await c.env.DB.prepare('SELECT * FROM classes WHERE id = ?').bind(classId).first<any>()
  if (password === null || password === '') {
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE classes SET student_pass_hash = NULL WHERE id = ?').bind(classId),
      // 学生密码清除后，已发的一体机令牌一并失效
      c.env.DB.prepare("DELETE FROM sessions WHERE kind = 'student' AND class_id = ?").bind(classId),
    ])
    return c.json({ ok: true, set: false })
  }
  if (!password || password.length < 4) return c.json({ error: '学生密码至少 4 位' }, 400)
  const hash = await hashStudentPassword(password, cls.legacy_sync_code)
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE classes SET student_pass_hash = ? WHERE id = ?').bind(hash, classId),
    c.env.DB.prepare("DELETE FROM sessions WHERE kind = 'student' AND class_id = ?").bind(classId),
  ])
  return c.json({ ok: true, set: true })
})

/** 一体机：学生密码解锁（公开接口，无会话要求）。 */
classRoutes.post('/api/classes/:id/kiosk-login', async (c) => {
  const { password } = await c.req.json<{ password?: string }>()
  const cls = await c.env.DB.prepare('SELECT * FROM classes WHERE id = ?')
    .bind(Number(c.req.param('id')))
    .first<any>()
  if (!cls?.student_pass_hash || !password || !(await verifyPassword(cls.student_pass_hash, password))) {
    return c.json({ error: '学生密码错误' }, 401)
  }
  const token = await createSession(c.env.DB, null, 'student', cls.id)
  return c.json({ token, classId: cls.id, className: cls.name })
})

/* ---------- 备份 / 恢复（JSON 全量，班级范围） ---------- */

classRoutes.get('/api/classes/:id/backup', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const cls = await c.env.DB.prepare('SELECT * FROM classes WHERE id = ?').bind(classId).first<any>()
  if (!cls) return c.json({ error: '班级不存在' }, 404)
  const dump = async (sql: string) => (await c.env.DB.prepare(sql).bind(classId).all<any>()).results
  return c.json({
    app: 'ark-class-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    class: cls,
    students: await dump('SELECT * FROM students WHERE class_id = ? ORDER BY id'),
    attendance: await dump('SELECT * FROM attendance WHERE class_id = ? ORDER BY id'),
    leaves: await dump('SELECT * FROM leaves WHERE class_id = ? ORDER BY id'),
    homework_records: await dump('SELECT * FROM homework_records WHERE class_id = ? ORDER BY id'),
    homework_tasks: await dump('SELECT * FROM homework_tasks WHERE class_id = ? ORDER BY id'),
    duty_roster: await dump('SELECT * FROM duty_roster WHERE class_id = ? ORDER BY id'),
    audit_logs: await dump('SELECT * FROM audit_logs WHERE class_id = ? ORDER BY id'),
  })
})

classRoutes.put('/api/classes/:id/restore', ...teacher, async (c) => {
  const classId = Number(c.req.param('id'))
  const data = await c.req.json<any>()
  if (data?.app !== 'ark-class-backup' || data?.version !== 1) {
    return c.json({ error: '不是有效的班级备份文件' }, 400)
  }
  if (Number(data.class?.id) !== classId) {
    return c.json(
      { error: `备份属于班级 ${data.class?.id}，与当前班级 ${classId} 不符` },
      400,
    )
  }
  const cls = await c.env.DB.prepare('SELECT * FROM classes WHERE id = ?').bind(classId).first<any>()
  if (!cls) return c.json({ error: '班级不存在' }, 404)

  const ins = (table: string, cols: string[], rows: any[]) =>
    rows.map((r) =>
      c.env.DB
        .prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .bind(...cols.map((col) => r[col] ?? null)),
    )

  await c.env.DB.batch([
    // 子表先行删除（外键约束），再按备份原样写回（保留 id）
    c.env.DB.prepare('DELETE FROM audit_logs WHERE class_id = ?').bind(classId),
    c.env.DB.prepare('DELETE FROM duty_roster WHERE class_id = ?').bind(classId),
    c.env.DB.prepare('DELETE FROM homework_tasks WHERE class_id = ?').bind(classId),
    c.env.DB.prepare('DELETE FROM homework_records WHERE class_id = ?').bind(classId),
    c.env.DB.prepare('DELETE FROM leaves WHERE class_id = ?').bind(classId),
    c.env.DB.prepare('DELETE FROM attendance WHERE class_id = ?').bind(classId),
    c.env.DB.prepare('DELETE FROM students WHERE class_id = ?').bind(classId),
    ...ins('students', ['id', 'class_id', 'name', 'seq', 'pinyin_initial', 'active', 'updated_at'], data.students ?? []),
    ...ins('attendance', ['id', 'class_id', 'day', 'student_id', 'slot', 'status', 'note', 'updated_by_role', 'updated_at'], data.attendance ?? []),
    ...ins('leaves', ['id', 'class_id', 'student_id', 'from_day', 'to_day', 'reason', 'status', 'decided_by', 'created_at'], data.leaves ?? []),
    ...ins('homework_records', ['id', 'class_id', 'day', 'subject', 'title', 'missing_json', 'deleted', 'updated_at'], data.homework_records ?? []),
    ...ins('homework_tasks', ['id', 'class_id', 'day', 'subject', 'content', 'deleted', 'updated_at'], data.homework_tasks ?? []),
    ...ins('duty_roster', ['id', 'class_id', 'week_start', 'weekday', 'student_id', 'role', 'seq'], data.duty_roster ?? []),
    ...ins('audit_logs', ['id', 'class_id', 'ts', 'actor', 'actor_id', 'action', 'detail'], data.audit_logs ?? []),
  ])

  return c.json({
    ok: true,
    counts: {
      students: (data.students ?? []).length,
      attendance: (data.attendance ?? []).length,
      leaves: (data.leaves ?? []).length,
      homework_records: (data.homework_records ?? []).length,
      homework_tasks: (data.homework_tasks ?? []).length,
    },
  })
})
