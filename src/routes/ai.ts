import { Hono } from 'hono'
import dayjs from 'dayjs'
import type { AppContext } from '../types.js'
import { authenticate, requireRole } from '../auth.js'
import { aiEnabled, aiComplete, extractJson, AiError } from '../ai.js'
import { collectReport } from './reports.js'
import { maskName } from './parent.js'

export const aiRoutes = new Hono<AppContext>()

/** AI 能力开关状态（前端据此显示/隐藏入口）。 */
aiRoutes.get('/api/ai/status', authenticate, (c) => c.json({ enabled: aiEnabled(c.env) }))

/** 把 "张三（2026-01-05 事由）" 这类复合串的姓名部分脱敏。 */
function maskLeaveName(s: string): string {
  return s.replace(/^([^（]+)（/, (_, n) => maskName(n) + '（')
}

/* ---------- AI 班级周总结（连贯文本，可复制发家长群） ---------- */

aiRoutes.post(
  '/api/classes/:id/report/summary',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    if (!aiEnabled(c.env)) return c.json({ error: 'AI 未配置' }, 503)
    const classId = Number(c.req.param('id'))
    const { from, to } = await c.req.json<{ from?: string; to?: string }>()
    const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : dayjs().subtract(6, 'day').format('YYYY-MM-DD')
    const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : dayjs().format('YYYY-MM-DD')

    const report = await collectReport(c.env.DB, classId, f, t)
    // 出域脱敏：姓名一律 mask；违纪明细不进 prompt（家长群总结不应包含）
    const data = {
      区间: `${f} 至 ${t}`,
      总人数: report.total_students,
      出勤: report.attendance.map((r) => ({ 姓名: maskName(r.name), 请假: r.leave, 迟到: r.late, 旷课: r.absent, 违纪: r.violate })),
      请假事由: report.leave_names.map(maskLeaveName),
      作业未交: report.homework.filter((h) => h.count > 0).map((h) => ({ 姓名: maskName(h.name), 次数: h.count, 明细: h.detail })),
    }

    try {
      const text = await aiComplete(
        c.env,
        '你是学校班级管理系统的班主任助手。请根据用户提供的脱敏数据（学生姓名已脱敏为"姓+拼音首字母"）写一段班级周总结。要求：1) 全中文，150~300 字；2) 语气客观温和，面向班主任，可整段复制发到家长群；3) 概括出勤整体情况，点名需要关注的异常（请假/迟到/作业未交集中情况，引用脱敏姓名）；4) 只使用给出的数据，绝不编造；5) 结尾加一句给家长的提醒或鼓励。直接输出正文，不要标题，不要分点符号。',
        JSON.stringify(data),
        { maxTokens: 700 },
      )
      return c.json({ text })
    } catch (e: any) {
      return c.json({ error: e instanceof AiError ? e.message : 'AI 调用失败' }, 502)
    }
  },
)

/* ---------- 考勤洞察（近 30 天模式提醒，JSON 列表） ---------- */

aiRoutes.post(
  '/api/classes/:id/attendance/insights',
  authenticate,
  requireRole('teacher', 'admin'),
  async (c) => {
    if (!aiEnabled(c.env)) return c.json({ error: 'AI 未配置' }, 503)
    const classId = Number(c.req.param('id'))
    const since = dayjs().subtract(29, 'day').format('YYYY-MM-DD')
    const today = dayjs().format('YYYY-MM-DD')

    const students = (
      await c.env.DB.prepare('SELECT id, name FROM students WHERE class_id = ?1 AND active = 1 ORDER BY seq')
        .bind(classId)
        .all<any>()
    ).results
    const rows = (
      await c.env.DB.prepare(
        `SELECT student_id, day, slot, status, note FROM attendance
         WHERE class_id = ?1 AND day >= ?2 AND day <= ?3`,
      )
        .bind(classId, since, today)
        .all<any>()
    ).results
    const CNT = ['leave', 'late', 'absent', 'violate'] as const
    const seen = new Set<string>()
    const agg = new Map<number, Record<string, number>>()
    const patterns = new Map<number, string[]>() // 记录连续性线索原文（如"11-18 迟到 / 11-19 迟到"）
    for (const r of rows) {
      if (!CNT.includes(r.status)) continue
      const key = `${r.student_id}|${r.day}|${r.status}`
      if (seen.has(key)) continue
      seen.add(key)
      const a = agg.get(r.student_id) ?? { leave: 0, late: 0, absent: 0, violate: 0 }
      a[r.status]++
      agg.set(r.student_id, a)
      const list = patterns.get(r.student_id) ?? []
      list.push(`${r.day.slice(5)} ${r.status}${r.note ? '(' + r.note + ')' : ''}`)
      patterns.set(r.student_id, list)
    }

    const data = {
      区间: `${since} 至 ${today}（近 30 天）`,
      总人数: students.length,
      学生: students
        .map((s) => {
          const a = agg.get(s.id)
          if (!a || (a.leave + a.late + a.absent + a.violate === 0)) return null
          return { 姓名: maskName(s.name), ...a, 线索: (patterns.get(s.id) ?? []).slice(0, 8) }
        })
        .filter(Boolean),
    }

    try {
      const text = await aiComplete(
        c.env,
        '你是班级考勤数据分析助手。根据用户提供的近 30 天脱敏考勤数据，找出值得班主任关注的模式（如连续迟到、频繁请假、旷课集中在某几天、违纪反复等）。要求：1) 输出 JSON 数组，2~4 条，每条形如 {"level":"info"或"warn","text":"一句话洞察+一句可操作建议"}；2) 全中文，每条不超过 60 字；3) 只基于给出的数据，绝不编造；4) 不要列出没有异常的学生。直接输出 JSON 数组，不要多余文字。',
        JSON.stringify(data),
        { maxTokens: 500 },
      )
      const parsed = extractJson<Array<{ level?: string; text?: string }>>(text)
      const items = (Array.isArray(parsed) ? parsed : [])
        .filter((it) => it && typeof it.text === 'string' && it.text.trim())
        .slice(0, 5)
        .map((it) => ({ level: it.level === 'warn' ? 'warn' : 'info', text: it.text!.trim() }))
      if (!items.length) return c.json({ items: [{ level: 'info', text: '近 30 天没有发现明显的考勤模式问题。' }] })
      return c.json({ items })
    } catch (e: any) {
      return c.json({ error: e instanceof AiError ? e.message : 'AI 调用失败' }, 502)
    }
  },
)
