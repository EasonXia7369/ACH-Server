import { beforeAll, describe, expect, it } from 'vitest'
import { createTestCtx } from './helpers.js'

const { inject } = createTestCtx()

describe('M4 作业与值日', () => {
  let teacherToken: string
  let kioskToken: string
  let classId: number
  let stuIds: number[] = []

  beforeAll(async () => {
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
    for (const name of ['陈一', '陈二', '陈三']) {
      const r = await inject({
        method: 'POST',
        url: `/api/classes/${classId}/students`,
        payload: { name },
        headers: { authorization: `Bearer ${teacherToken}` },
      })
      stuIds.push(r.json().student.id)
    }
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/student-pass`,
      payload: { password: '1234' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    kioskToken = (
      await inject({
        method: 'POST',
        url: `/api/classes/${classId}/kiosk-login`,
        payload: { password: '1234' },
      })
    ).json().token
  })

  it('登记作业未交并读取', async () => {
    const res = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/hw-records`,
      payload: {
        day: '2026-11-13',
        subject: '数学',
        title: '练习册 P32',
        missing: [stuIds[0], stuIds[2]],
      },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(res.statusCode).toBe(200)

    const read = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/hw-records?from=2026-11-13&to=2026-11-13`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(read.json().records).toHaveLength(1)
    expect(read.json().records[0].missing).toEqual([stuIds[0], stuIds[2]])
  })

  it('学生令牌可以登记作业未交', async () => {
    const res = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/hw-records`,
      payload: { day: '2026-11-13', subject: '英语', title: '', missing: [stuIds[1]] },
      headers: { authorization: `Bearer ${kioskToken}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('重复写入覆盖（陈一交了作业 → missing 只剩陈三）', async () => {
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/hw-records`,
      payload: { day: '2026-11-13', subject: '数学', title: '练习册 P32', missing: [stuIds[2]] },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const read = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/hw-records?from=2026-11-13&to=2026-11-13`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const math = read.json().records.find((r: any) => r.subject === '数学')
    expect(math.missing).toEqual([stuIds[2]])
  })

  it('布置作业；清空内容即删除', async () => {
    const put = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/hw-tasks`,
      payload: { day: '2026-11-13', subject: '语文', content: '背诵课文第 3 段' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(put.statusCode).toBe(200)

    const read = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/hw-tasks?from=2026-11-13&to=2026-11-13`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(read.json().tasks).toEqual([{ day: '2026-11-13', subject: '语文', content: '背诵课文第 3 段' }])

    // 学生不能布置作业
    const noPerm = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/hw-tasks`,
      payload: { day: '2026-11-13', subject: '语文', content: 'x' },
      headers: { authorization: `Bearer ${kioskToken}` },
    })
    expect(noPerm.statusCode).toBe(403)

    const clear = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/hw-tasks`,
      payload: { day: '2026-11-13', subject: '语文', content: '' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(clear.json().cleared).toBe(true)
    const read2 = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/hw-tasks?from=2026-11-13&to=2026-11-13`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(read2.json().tasks).toHaveLength(0)
  })

  it('值日表：排班、按周读取、今日值日生', async () => {
    // 2026-11-09 是周一
    const put = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/duty`,
      payload: {
        week_start: '2026-11-09',
        weekday: 3,
        members: [
          { student_id: stuIds[0], role: '组长' },
          { student_id: stuIds[1], role: '' },
        ],
      },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(put.statusCode).toBe(200)

    // 用当周周三日期读取
    const read = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/duty?week=2026-11-11`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(read.json().week_start).toBe('2026-11-09')
    const wed = read.json().days.find((d: any) => d.weekday === 3)
    expect(wed.members.map((m: any) => m.name)).toEqual(['陈一', '陈二'])
    expect(wed.members[0].role).toBe('组长')

    // 其他天为空
    const mon = read.json().days.find((d: any) => d.weekday === 1)
    expect(mon.members).toHaveLength(0)

    // 重排同一天 = 覆盖
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/duty`,
      payload: { week_start: '2026-11-09', weekday: 3, members: [{ student_id: stuIds[2] }] },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const read2 = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/duty?week=2026-11-11`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const wed2 = read2.json().days.find((d: any) => d.weekday === 3)
    expect(wed2.members.map((m: any) => m.name)).toEqual(['陈三'])
  })

  it('week_start 非周一被拒绝', async () => {
    const res = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/duty`,
      payload: { week_start: '2026-11-10', weekday: 1, members: [] },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('审计日志包含作业与值日操作', async () => {
    const res = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/audit`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const actions = res.json().logs.map((l: any) => l.action)
    expect(actions).toContain('作业未交登记')
    expect(actions).toContain('学生登记作业')
    expect(actions).toContain('布置作业')
    expect(actions).toContain('排值日')
  })
})
