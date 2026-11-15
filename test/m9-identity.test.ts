import { describe, expect, it } from 'vitest'
import { createTestCtx } from './helpers.js'

const { inject } = createTestCtx()

describe('T2 轻量学生身份 + 多教师协作', () => {
  let teacherToken: string
  let kioskToken: string
  let classId: number
  let stuId: number

  it('准备：建班 + 学生 + 学生密码 + 一体机会话', async () => {
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
      payload: { name: '高二6班' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    classId = cls.json().class.id
    const stu = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/students`,
      payload: { name: '陈一' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    stuId = stu.json().student.id
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
    expect(kioskToken).toBeTruthy()
  })

  it('值日生认领身份发消息 → sender_name 为学生名', async () => {
    const send = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages`,
      payload: { body: '作业收齐了', actor_student_id: stuId },
      headers: { authorization: `Bearer ${kioskToken}` },
    })
    expect(send.statusCode).toBe(200)
    expect(send.json().message.sender_name).toBe('陈一')

    const hist = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/messages`,
      headers: { authorization: `Bearer ${kioskToken}` },
    })
    expect(hist.json().messages[0].sender_name).toBe('陈一')
  })

  it('不认领身份发消息 → 显示「值日生」', async () => {
    const send = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages`,
      payload: { body: '未认领' },
      headers: { authorization: `Bearer ${kioskToken}` },
    })
    expect(send.statusCode).toBe(200)
    expect(send.json().message.sender_name).toBe('值日生')
  })

  it('认领不属于本班的学生被拒绝', async () => {
    const send = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages`,
      payload: { body: 'x', actor_student_id: 9999 },
      headers: { authorization: `Bearer ${kioskToken}` },
    })
    expect(send.statusCode).toBe(400)
  })

  it('考勤登记带认领身份 → 审计留痕到人', async () => {
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/attendance`,
      payload: {
        day: '2026-11-15',
        actor_student_id: stuId,
        entries: [{ student_id: stuId, slot: 'morning', status: 'present' }],
      },
      headers: { authorization: `Bearer ${kioskToken}` },
    })
    const audit = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/audit`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const log = audit.json().logs.find((l: any) => l.action === '学生登记考勤')
    expect(log.detail).toContain('陈一')
  })

  it('协作教师：添加 → 可访问班级 → 移除 → 失去访问', async () => {
    // 第二位教师
    const admin = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: '管理员', password: 'admin123' },
    })
    const inv = await inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { role: 'teacher' },
      headers: { authorization: `Bearer ${admin.json().token}` },
    })
    const t2 = await inject({
      method: 'POST',
      url: '/api/auth/activate',
      payload: { code: inv.json().code, name: '王老师', password: 'wang123' },
    })
    const t2Token = t2.json().token
    const t2Id = t2.json().user.id

    // 未加入前：王老师不能读班级
    const before = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/messages`,
      headers: { authorization: `Bearer ${t2Token}` },
    })
    expect(before.statusCode).toBe(403)

    // 添加协作教师（教师自己操作）
    const add = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/teachers`,
      payload: { user_id: t2Id },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(add.statusCode).toBe(200)

    const after = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/messages`,
      headers: { authorization: `Bearer ${t2Token}` },
    })
    expect(after.statusCode).toBe(200)

    // 班级详情包含教师团队
    const detail = await inject({
      method: 'GET',
      url: `/api/classes/${classId}`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const names = detail.json().teachers.map((t: any) => t.name)
    expect(names).toEqual(expect.arrayContaining(['张老师', '王老师']))

    // 移除 → 失去访问
    const remove = await inject({
      method: 'DELETE',
      url: `/api/classes/${classId}/teachers/${t2Id}`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(remove.statusCode).toBe(200)
    const denied = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/messages`,
      headers: { authorization: `Bearer ${t2Token}` },
    })
    expect(denied.statusCode).toBe(403)
  })

  it('不能移除班主任', async () => {
    const detail = await inject({
      method: 'GET',
      url: `/api/classes/${classId}`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const owner = detail.json().teachers.find((t: any) => t.is_owner)
    const res = await inject({
      method: 'DELETE',
      url: `/api/classes/${classId}/teachers/${owner.id}`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(res.statusCode).toBe(400)
  })
})
