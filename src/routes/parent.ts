import { Hono } from 'hono'
import dayjs from 'dayjs'
import { pinyin } from 'pinyin-pro'
import type { AppContext } from '../types.js'

/** 姓名脱敏：张三 → 张S（姓 + 名的拼音首字母，家长可读、外人不可读）。 */
export function maskName(name: string): string {
  const chars = [...name.trim()]
  if (chars.length <= 1) return name
  const surname = chars[0]
  const given = chars.slice(1).join('')
  const initials = pinyin(given, { pattern: 'first', toneType: 'none', type: 'array' })
    .map((s) => (s || '?').toUpperCase())
    .join('')
  return surname + initials
}

export const parentRoutes = new Hono<AppContext>()

/**
 * 家长只读视图（公开，凭班级 parent_key 访问）：
 * 今日作业 + 本周考勤（姓名脱敏）+ 今日课程。聊天消息不在其中。
 */
parentRoutes.get('/api/parent/:key', async (c) => {
  const key = c.req.param('key')
  const cls = await c.env.DB
    .prepare('SELECT id, name FROM classes WHERE parent_key = ?1')
    .bind(key)
    .first<{ id: number; name: string }>()
  if (!cls) return c.json({ error: '链接无效' }, 404)
  const classId = cls.id

  const today = dayjs().format('YYYY-MM-DD')
  const weekStart = dayjs(today).day() === 0 ? 6 : dayjs(today).day()
  const mon = dayjs(today)
    .subtract(dayjs(today).day() === 0 ? 6 : dayjs(today).day() - 1, 'day')
    .format('YYYY-MM-DD')

  const mask = (name: string) => maskName(name)

  const [tasks, attendance, timetable] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT subject, content FROM homework_tasks
         WHERE class_id = ?1 AND deleted = 0 AND day = ?2 ORDER BY subject`,
      )
      .bind(classId, today)
      .all<any>()
      .then((r) => r.results),
    c.env.DB
      .prepare(
        `SELECT a.student_id, a.slot, a.status, a.note FROM attendance a
         WHERE a.class_id = ?1 AND a.day = ?2`,
      )
      .bind(classId, today)
      .all<any>()
      .then((r) => r.results),
    c.env.DB
      .prepare(
        `SELECT period, subject, teacher FROM timetable
         WHERE class_id = ?1 AND weekday = ?2 AND subject != '' ORDER BY period`,
      )
      .bind(classId, dayjs(today).day() === 0 ? 7 : dayjs(today).day())
      .all<any>()
      .then((r) => r.results),
  ])

  // 脱敏的今日出勤
  const students = (
    await c.env.DB.prepare(
      'SELECT id, name FROM students WHERE class_id = ?1 AND active = 1 ORDER BY seq',
    )
      .bind(classId)
      .all<any>()
  ).results
  const att = attendance.map((r: any) => {
    const stu = students.find((s) => s.id === r.student_id)
    return { student: stu ? mask(stu.name) : '?', slot: r.slot, status: r.status, note: r.note }
  })

  // 本周统计（脱敏，按天口径）
  const rows = (
    await c.env.DB.prepare(
      `SELECT student_id, day, status FROM attendance
       WHERE class_id = ?1 AND day >= ?2 AND day <= ?3`,
    )
      .bind(classId, mon, today)
      .all<any>()
  ).results
  const CNT = ['leave', 'late', 'absent', 'violate'] as const
  const agg = new Map<number, Record<string, number>>()
  const seen = new Set<string>()
  for (const r of rows) {
    const a = agg.get(r.student_id) ?? { leave: 0, late: 0, absent: 0, violate: 0 }
    const k = `${r.student_id}|${r.day}|${r.status}`
    if (!seen.has(k)) {
      seen.add(k)
      if (CNT.includes(r.status)) a[r.status]++
    }
    agg.set(r.student_id, a)
  }
  const weekly = students.map((s) => {
    const a = agg.get(s.id) ?? { leave: 0, late: 0, absent: 0, violate: 0 }
    return { student: mask(s.name), ...a }
  })

  return c.json({
    class_name: cls.name,
    day: today,
    homework: tasks,
    attendance_today: att,
    weekly,
    timetable,
  })
})
