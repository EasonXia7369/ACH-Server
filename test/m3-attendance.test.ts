import { beforeAll, describe, expect, it } from 'vitest'
import { createTestCtx } from './helpers.js'

const { inject } = createTestCtx()

describe('M3 考勤核心', () => {
  let adminToken: string
  let teacherToken: string
  let classId: number
  let stuIds: number[] = []
  let kioskToken: string
  let pendingLeaveId: number

  beforeAll(async () => {
    // 引导管理员 + 生成教师邀请码 + 教师激活建班加学生
    const admin = await inject({
      method: 'POST',
      url: '/api/auth/activate',
      payload: { code: 'TESTBOOT', name: '管理员', password: 'admin123' },
    })
    adminToken = admin.json().token
    const inv = await inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { role: 'teacher' },
      headers: { authorization: `Bearer ${adminToken}` },
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
    for (const name of ['陈一', '陈二', '陈三', '陈四']) {
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
    const kiosk = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/kiosk-login`,
      payload: { password: '1234' },
    })
    kioskToken = kiosk.json().token
  })

  it('批量登记考勤（present 不落盘）', async () => {
    const res = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/attendance`,
      payload: {
        day: '2026-11-13',
        entries: [
          { student_id: stuIds[0], slot: 'morning', status: 'present' },
          { student_id: stuIds[1], slot: 'morning', status: 'late', note: '迟到 10 分钟' },
          { student_id: stuIds[2], slot: 'morning', status: 'absent', note: '未到校' },
          { student_id: stuIds[3], slot: 'morning', status: 'violate', note: '课堂纪律' },
        ],
      },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(res.statusCode).toBe(200)

    const read = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/attendance?day=2026-11-13`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const recs = read.json().records
    expect(recs).toHaveLength(3) // present 不落盘
    expect(recs.map((r: any) => r.status).sort()).toEqual(['absent', 'late', 'violate'])
    expect(recs.every((r: any) => r.name)).toBe(true)
  })

  it('重复登记覆盖原状态；改为 present 即清除', async () => {
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/attendance`,
      payload: {
        day: '2026-11-13',
        entries: [{ student_id: stuIds[1], slot: 'morning', status: 'absent', note: '病假' }],
      },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    let read = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/attendance?day=2026-11-13`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    let late = read.json().records.find((r: any) => r.student_id === stuIds[1])
    expect(late.status).toBe('absent')

    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/attendance`,
      payload: {
        day: '2026-11-13',
        entries: [{ student_id: stuIds[1], slot: 'morning', status: 'present' }],
      },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    read = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/attendance?day=2026-11-13`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    late = read.json().records.find((r: any) => r.student_id === stuIds[1])
    expect(late).toBeUndefined()
  })

  it('学生令牌可以登记考勤', async () => {
    const res = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/attendance`,
      payload: {
        day: '2026-11-13',
        entries: [{ student_id: stuIds[0], slot: 'noon', status: 'late', note: '学生登记' }],
      },
      headers: { authorization: `Bearer ${kioskToken}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('非法状态/时段被拒绝', async () => {
    const res = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/attendance`,
      payload: {
        day: '2026-11-13',
        entries: [{ student_id: stuIds[0], slot: 'morning', status: 'hack' }],
      },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('月度统计：按天口径同日同状态去重', async () => {
    // 陈一在 11-13 有 noon late；再加 11-13 evening late（按天应只算 1 次 late）
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/attendance`,
      payload: {
        day: '2026-11-13',
        entries: [{ student_id: stuIds[0], slot: 'evening', status: 'late' }],
      },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const dayMode = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/attendance/stats?month=2026-11&mode=day`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(dayMode.statusCode).toBe(200)
    const dayStats = dayMode.json().stats
    const stu1Day = dayStats.find((s: any) => s.id === stuIds[0])
    expect(stu1Day.late).toBe(1)

    const timeMode = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/attendance/stats?month=2026-11&mode=time`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const stu1Time = timeMode.json().stats.find((s: any) => s.id === stuIds[0])
    expect(stu1Time.late).toBe(2)
  })

  it('老师直接登记请假：自动批准并展开多天多时段', async () => {
    const res = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/leaves`,
      payload: {
        student_id: stuIds[2],
        from_day: '2026-11-16',
        to_day: '2026-11-18',
        reason: '感冒发烧',
      },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('approved')
    expect(res.json().days).toBe(3)

    // 11-16 的三个时段都应是 leave
    const read = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/attendance?day=2026-11-16`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const slots = read.json().records.filter((r: any) => r.student_id === stuIds[2])
    expect(slots).toHaveLength(3)
    expect(slots.every((r: any) => r.status === 'leave')).toBe(true)
    expect(slots[0].note).toBe('请假：感冒发烧')
  })

  it('学生令牌可以发起请假申请（进入待审批），但不能审批', async () => {
    const apply = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/leaves`,
      payload: {
        student_id: stuIds[0],
        from_day: '2026-11-20',
        to_day: '2026-11-20',
        reason: '牙疼',
      },
      headers: { authorization: `Bearer ${kioskToken}` },
    })
    expect(apply.statusCode).toBe(200)
    expect(apply.json().status).toBe('pending')
    pendingLeaveId = apply.json().id

    // 学生不能审批
    const decision = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/leaves/${pendingLeaveId}/decision`,
      payload: { approve: true },
      headers: { authorization: `Bearer ${kioskToken}` },
    })
    expect(decision.statusCode).toBe(403)
  })

  it('老师审批待处理请假单', async () => {
    const approve = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/leaves/${pendingLeaveId}/decision`,
      payload: { approve: true },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(approve.statusCode).toBe(200)
    expect(approve.json().status).toBe('approved')
    expect(approve.json().days).toBe(1)
  })

  it('删除已批准请假单会清除其生成的考勤格', async () => {
    const list = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/leaves`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const approved = list.json().leaves.find(
      (l: any) => l.status === 'approved' && l.from_day === '2026-11-16',
    )
    expect(approved).toBeTruthy()

    const del = await inject({
      method: 'DELETE',
      url: `/api/classes/${classId}/leaves/${approved.id}`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(del.statusCode).toBe(200)

    const read = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/attendance?day=2026-11-16`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(read.json().records.filter((r: any) => r.student_id === stuIds[2])).toHaveLength(0)
  })

  it('审计日志记录操作与角色', async () => {
    const res = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/audit`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const logs = res.json().logs
    expect(logs.length).toBeGreaterThanOrEqual(5)
    const roles = logs.map((l: any) => l.actor)
    expect(roles).toContain('teacher')
    expect(roles).toContain('student')
    const mark = logs.find((l: any) => l.action === '考勤标记')
    expect(mark.detail).toContain('2026-11-13')
  })
})
