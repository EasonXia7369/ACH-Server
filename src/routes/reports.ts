import { Hono } from 'hono'
import type { AppContext } from '../types.js'
import { authenticate, requireRole } from '../auth.js'

export const reportRoutes = new Hono<AppContext>()

function dateOf(v?: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

/**
 * 周报聚合：区间内考勤统计（按天口径）+ 请假明细 + 作业未交汇总。
 * GET /api/classes/:id/report?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
reportRoutes.get(
  '/api/classes/:id/report',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    const classId = Number(c.req.param('id'))
    const from = dateOf(c.req.query('from'))
    const to = dateOf(c.req.query('to'))
    if (!from || !to || from > to) {
      return c.json({ error: 'from/to 必须为有效的 YYYY-MM-DD 且 from ≤ to' }, 400)
    }

    const students = (
      await c.env.DB.prepare(
        'SELECT id, name FROM students WHERE class_id = ?1 AND active = 1 ORDER BY seq',
      )
        .bind(classId)
        .all<any>()
    ).results

    /* 考勤（按天口径：同日同状态只算 1 次） */
    const attRows = (
      await c.env.DB.prepare(
        `SELECT student_id, day, slot, status, note FROM attendance
         WHERE class_id = ?1 AND day >= ?2 AND day <= ?3`,
      )
        .bind(classId, from, to)
        .all<any>()
    ).results
    const CNT = ['leave', 'late', 'absent', 'violate'] as const
    const attAgg = new Map<number, Record<string, number>>()
    const seen = new Set<string>()
    const violations: Array<{ day: string; name: string; slot: string; note: string }> = []
    const leaveNames = new Set<string>()

    for (const r of attRows) {
      const agg = attAgg.get(r.student_id) ?? { leave: 0, late: 0, absent: 0, violate: 0, total: 0 }
      const key = `${r.student_id}|${r.day}|${r.status}`
      if (!seen.has(key)) {
        seen.add(key)
        if (CNT.includes(r.status)) {
          agg[r.status]++
          agg.total++
        }
      }
      attAgg.set(r.student_id, agg)
      if (r.status === 'violate' || r.status === 'leave' || r.status === 'absent') {
        const stu = students.find((s) => s.id === r.student_id)
        if (stu) {
          if (r.status === 'leave' || r.status === 'absent') leaveNames.add(`${stu.name}（${r.day} ${r.note || r.status}）`)
          if (r.status === 'violate') violations.push({ day: r.day, name: stu.name, slot: r.slot, note: r.note })
        }
      }
    }

    const attendance = students.map((s, i) => ({
      seq: i + 1,
      name: s.name,
      ...(attAgg.get(s.id) ?? { leave: 0, late: 0, absent: 0, violate: 0, total: 0 }),
    }))

    /* 请假单（区间内有交集的已批准单） */
    const leaves = (
      await c.env.DB.prepare(
        `SELECT l.from_day, l.to_day, st.name, l.reason FROM leaves l
         JOIN students st ON st.id = l.student_id
         WHERE l.class_id = ?1 AND l.status = 'approved'
           AND l.from_day <= ?3 AND l.to_day >= ?2
         ORDER BY l.from_day`,
      )
        .bind(classId, from, to)
        .all<any>()
    ).results

    /* 作业未交汇总 */
    const hwRows = (
      await c.env.DB.prepare(
        `SELECT day, subject, missing_json FROM homework_records
         WHERE class_id = ?1 AND deleted = 0 AND day >= ?2 AND day <= ?3 ORDER BY day`,
      )
        .bind(classId, from, to)
        .all<any>()
    ).results
    const hwAgg = new Map<number, { name: string; count: number; detail: string[] }>()
    for (const s of students) hwAgg.set(s.id, { name: s.name, count: 0, detail: [] })
    for (const r of hwRows) {
      for (const sid of JSON.parse(r.missing_json) as number[]) {
        const entry = hwAgg.get(sid)
        if (!entry) continue
        entry.count++
        entry.detail.push(`${r.day} ${r.subject}`)
      }
    }
    const homework = [...hwAgg.values()].sort((a, b) => b.count - a.count)

    return c.json({
      from,
      to,
      total_students: students.length,
      attendance,
      violations,
      leave_names: [...leaveNames],
      leaves,
      homework,
    })
  },
)
