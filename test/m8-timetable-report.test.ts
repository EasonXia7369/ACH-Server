import { describe, expect, it } from 'vitest'
import { createTestCtx } from './helpers.js'

const { inject } = createTestCtx()

describe('课程表与周报', () => {
  let teacherToken: string
  let classId: number
  let stuIds: number[] = []

  it('准备', async () => {
    const admin = await inject({
      method: 'POST',
      url: '/api/auth/activate',
      payload: { code: 'TESTBOOT', name: '管理员', password: 'admin123' },
    })
    const inv = await inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { role: 'teacher' },
      headers: { authorization: `Bearer ${admin.json().token}` },
    })
    const teacher = await inject({
      method: 'POST',
      url: '/api/auth/activate',
      payload: { code: inv.json().code, name: '张老师', password: 'teach123' },
    })
    teacherToken = teacher.json().token
    const cls = await inject({
      method: 'POST',
      url: '/api/classes',
      payload: { name: '高一(3)班' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    classId = cls.json().class.id
    for (const name of ['陈一', '陈二']) {
      const r = await inject({
        method: 'POST',
        url: `/api/classes/${classId}/students`,
        payload: { name },
        headers: { authorization: `Bearer ${teacherToken}` },
      })
      stuIds.push(r.json().student.id)
    }
  })

  it('设置课表（周一 3 节）并读取', async () => {
    const put = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/timetable`,
      payload: {
        weekday: 1,
        periods: [
          { period: 1, subject: '语文', teacher: '王老师' },
          { period: 2, subject: '数学' },
          { period: 3, subject: '英语' },
        ],
      },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(put.statusCode).toBe(200)

    const get = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/timetable`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const mon = get.json().timetable.filter((r: any) => r.weekday === 1)
    expect(mon).toHaveLength(3)
    expect(mon[0].subject).toBe('语文')

    // 空科目行被过滤：period 4 不在结果里
    const put2 = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/timetable`,
      payload: {
        weekday: 1,
        periods: [
          { period: 1, subject: '语文' },
          { period: 2, subject: '' },
        ],
      },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(put2.statusCode).toBe(200)
    const get2 = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/timetable`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const mon2 = get2.json().timetable.filter((r: any) => r.weekday === 1)
    expect(mon2).toHaveLength(1)
  })

  it('非法 weekday / period 被拒绝', async () => {
    const bad1 = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/timetable`,
      payload: { weekday: 9, periods: [] },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(bad1.statusCode).toBe(400)
    const bad2 = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/timetable`,
      payload: { weekday: 1, periods: [{ period: 13, subject: 'x' }] },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(bad2.statusCode).toBe(400)
  })

  it('周报聚合：考勤 + 作业 + 请假', async () => {
    // 造数据：考勤异常 + 请假 + 作业未交
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/attendance`,
      payload: {
        day: '2026-11-09',
        entries: [
          { student_id: stuIds[0], slot: 'morning', status: 'late', note: '迟到' },
          { student_id: stuIds[1], slot: 'morning', status: 'absent', note: '未到校' },
        ],
      },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    await inject({
      method: 'POST',
      url: `/api/classes/${classId}/leaves`,
      payload: { student_id: stuIds[0], from_day: '2026-11-10', to_day: '2026-11-11', reason: '病假' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/hw-records`,
      payload: { day: '2026-11-11', subject: '数学', title: '', missing: [stuIds[1]] },
      headers: { authorization: `Bearer ${teacherToken}` },
    })

    const rep = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/report?from=2026-11-09&to=2026-11-13`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(rep.statusCode).toBe(200)
    const r = rep.json()

    expect(r.total_students).toBe(2)
    const stu1 = r.attendance.find((s: any) => s.name === '陈一')
    expect(stu1.late).toBe(1)
    const stu2 = r.attendance.find((s: any) => s.name === '陈二')
    expect(stu2.absent).toBe(1)

    expect(r.violations).toHaveLength(0) // 无违纪
    expect(r.leave_names.length).toBeGreaterThan(0)
    expect(r.leaves).toHaveLength(1)
    expect(r.leaves[0].reason).toBe('病假')

    const hw = r.homework.find((h: any) => h.name === '陈二')
    expect(hw.count).toBe(1)
  })

  it('日期范围非法被拒绝', async () => {
    const res = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/report?from=bad&to=2026-11-13`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(res.statusCode).toBe(400)
  })
})
