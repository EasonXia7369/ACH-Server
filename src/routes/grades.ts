import { Hono } from 'hono'
import type { AppContext } from '../types.js'
import { authenticate, isSchoolAdmin } from '../auth.js'

/**
 * 年级只读汇总（年级主任 / 校管理员 / 平台超管）。
 * 仅聚合查询，不提供任何写入路径——写入仍走班级级接口并按原权限校验。
 */

export const gradeRoutes = new Hono<AppContext>()

/** 当前用户可查看汇总的年级列表（主任→其年级；校管理员→本校；平台超管→全部）。 */
gradeRoutes.get('/api/grades/mine', authenticate, async (c) => {
  const user = c.get('user')!
  if (user.role === 'teacher') {
    const rows = (
      await c.env.DB.prepare(
        `SELECT g.id, g.name, s.name AS school_name,
                (SELECT COUNT(*) FROM classes cl WHERE cl.grade_id = g.id) AS class_count
         FROM grade_directors gd
         JOIN grades g ON g.id = gd.grade_id
         JOIN schools s ON s.id = g.school_id
         WHERE gd.user_id = ?1 ORDER BY g.sort, g.id`,
      )
        .bind(user.userId)
        .all<any>()
    ).results
    return c.json({ grades: rows })
  }
  if (user.role === 'admin') {
    const scoped =
      isSchoolAdmin(user)
        ? c.env.DB.prepare(
            `SELECT g.id, g.name, s.name AS school_name,
                    (SELECT COUNT(*) FROM classes cl WHERE cl.grade_id = g.id) AS class_count
             FROM grades g JOIN schools s ON s.id = g.school_id
             WHERE g.school_id = ?1 ORDER BY s.id, g.sort, g.id`,
          ).bind(user.schoolId)
        : c.env.DB.prepare(
            `SELECT g.id, g.name, s.name AS school_name,
                    (SELECT COUNT(*) FROM classes cl WHERE cl.grade_id = g.id) AS class_count
             FROM grades g JOIN schools s ON s.id = g.school_id
             ORDER BY s.id, g.sort, g.id`,
          )
    return c.json({ grades: (await scoped.all<any>()).results })
  }
  return c.json({ grades: [] })
})

/** 年级访问权：主任（教师）/ 本校校管理员 / 平台超管 */
async function gradeAccess(
  c: any,
  gradeId: number,
): Promise<{ ok: boolean; error?: string }> {
  const user = c.get('user')!
  if (user.role === 'admin') {
    if (isSchoolAdmin(user)) {
      const g = await c.env.DB
        .prepare('SELECT 1 AS ok FROM grades WHERE id = ?1 AND school_id = ?2')
        .bind(gradeId, user.schoolId)
        .first()
      return g ? { ok: true } : { ok: false, error: '年级不存在' }
    }
    return { ok: true } // 平台超管
  }
  if (user.role === 'teacher') {
    const ok = await c.env.DB
      .prepare('SELECT 1 AS ok FROM grade_directors WHERE grade_id = ?1 AND user_id = ?2')
      .bind(gradeId, user.userId)
      .first()
    return ok ? { ok: true } : { ok: false, error: '无权访问该年级' }
  }
  return { ok: false, error: '权限不足' }
}

function dateOf(v?: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

/** 年级概况：班级列表 + 指定日期（或区间）各班考勤汇总 + 当日作业。 */
gradeRoutes.get('/api/grades/:id/summary', authenticate, async (c) => {
  const gradeId = Number(c.req.param('id'))
  const access = await gradeAccess(c, gradeId)
  if (!access.ok) return c.json({ error: access.error }, access.error === '年级不存在' ? 404 : 403)

  const day = dateOf(c.req.query('day')) ?? new Date().toISOString().slice(0, 10)
  const to = dateOf(c.req.query('to')) ?? day

  const classes = (
    await c.env.DB.prepare(
      `SELECT cl.id, cl.name, u.name AS teacher_name,
              (SELECT COUNT(*) FROM students st WHERE st.class_id = cl.id AND st.active = 1) AS student_count
       FROM classes cl JOIN users u ON u.id = cl.teacher_id
       WHERE cl.grade_id = ?1 ORDER BY cl.id`,
    )
      .bind(gradeId)
      .all<any>()
  ).results

  // 考勤：按班聚合（同班同学生同状态去重，与月度统计「按天」口径一致）
  const ids = classes.map((cl: any) => cl.id)
  let attendance: Array<{ class_id: number; status: string; n: number }> = []
  if (ids.length) {
    attendance = (
      await c.env.DB.prepare(
        `SELECT a.class_id, a.status, COUNT(DISTINCT a.student_id || '|' || a.status) AS n
         FROM attendance a JOIN students st ON st.id = a.student_id
         WHERE a.class_id IN (${ids.map(() => '?').join(',')})
           AND a.day >= ? AND a.day <= ? AND st.active = 1
         GROUP BY a.class_id, a.status`,
      )
        .bind(...ids, day, to)
        .all<any>()
    ).results
  }

  const byClass = new Map<number, Record<string, number>>()
  for (const a of attendance) {
    const rec = byClass.get(a.class_id) ?? { leave: 0, late: 0, absent: 0, violate: 0 }
    if (a.status in rec) rec[a.status] = a.n
    byClass.set(a.class_id, rec)
  }

  // 当日作业（单日）
  const tasks = ids.length
    ? (
        await c.env.DB.prepare(
          `SELECT class_id, subject, content FROM homework_tasks
           WHERE class_id IN (${ids.map(() => '?').join(',')}) AND day = ? AND deleted = 0
           ORDER BY class_id, subject`,
        )
          .bind(...ids, day)
          .all<any>()
      ).results
    : []
  const tasksByClass = new Map<number, Array<{ subject: string; content: string }>>()
  for (const t of tasks) {
    const arr = tasksByClass.get(t.class_id) ?? []
    arr.push({ subject: t.subject, content: t.content })
    tasksByClass.set(t.class_id, arr)
  }

  return c.json({
    day,
    to,
    classes: classes.map((cl: any) => {
      const rec = byClass.get(cl.id) ?? { leave: 0, late: 0, absent: 0, violate: 0 }
      const exception = rec.leave + rec.late + rec.absent + rec.violate
      return {
        id: cl.id,
        name: cl.name,
        teacher_name: cl.teacher_name,
        student_count: cl.student_count,
        present: Math.max(0, cl.student_count - exception),
        ...rec,
        tasks: tasksByClass.get(cl.id) ?? [],
      }
    }),
  })
})
