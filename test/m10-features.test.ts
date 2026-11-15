import { describe, expect, it } from 'vitest'
import { createTestCtx } from './helpers.js'

const { inject, rawRequest, db } = createTestCtx()

describe('消息弹出开关/删除 + 快捷短语 + 家长链接 + 创建教师账号', () => {
  let teacherToken: string
  let kioskToken: string
  let classId: number
  let stuId: number
  let msgId: number

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
  })

  it('发送带弹屏开关的消息（popup: false 不弹）', async () => {
    const res = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages`,
      payload: { body: '安静自习', popup: false },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().message.popup).toBe(false)
    msgId = res.json().message.id

    const res2 = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages`,
      payload: { body: '请注意', popup: true },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(res2.json().message.popup).toBe(true)
  })

  it('历史返回 popup 字段且过滤已删除', async () => {
    const read = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/messages`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(read.json().messages.every((m: any) => typeof m.popup === 'boolean')).toBe(true)
    expect(read.json().messages).toHaveLength(2)

    // 值日生删除自己认领身份的消息（先发一条再删）
    const send = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages`,
      payload: { body: '测试删除', actor_student_id: stuId },
      headers: { authorization: `Bearer ${kioskToken}` },
    })
    expect(send.statusCode).toBe(200)
    const del = await inject({
      method: 'DELETE',
      url: `/api/classes/${classId}/messages/${send.json().message.id}`,
      headers: { authorization: `Bearer ${kioskToken}` },
    })
    expect(del.statusCode).toBe(200)
    const after = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/messages`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(after.json().messages.some((m: any) => m.id === send.json().message.id)).toBe(false)
  })

  it('老师可删任意消息；值日生不能删老师消息', async () => {
    const del = await inject({
      method: 'DELETE',
      url: `/api/classes/${classId}/messages/${msgId}`,
      headers: { authorization: `Bearer ${kioskToken}` },
    })
    expect(del.statusCode).toBe(403)
  })

  it('快捷短语：默认空 → 配置 → 读取', async () => {
    const empty = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/quick-phrases`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(empty.json().phrases).toEqual([])

    const put = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/quick-phrases`,
      payload: { phrases: ['作业收齐了', '请求老师来教室', '一切正常'] },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json().phrases).toHaveLength(3)

    const read = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/quick-phrases`,
      headers: { authorization: `Bearer ${kioskToken}` },
    })
    expect(read.json().phrases).toHaveLength(3)
  })

  it('管理员直接创建教师账号', async () => {
    const admin = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: '管理员', password: 'admin123' },
    })
    const res = await inject({
      method: 'POST',
      url: '/api/admin/users',
      payload: { name: '新老师', password: 'newpass' },
      headers: { authorization: `Bearer ${admin.json().token}` },
    })
    expect(res.statusCode).toBe(200)

    const login = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: '新老师', password: 'newpass' },
    })
    expect(login.statusCode).toBe(200)
  })

  it('家长链接：生成 → 公开读取（姓名脱敏）', async () => {
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/attendance`,
      payload: {
        day: '2026-11-15',
        entries: [{ student_id: stuId, slot: 'morning', status: 'late', note: '迟到 5 分钟' }],
      },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const gen = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/parent-link`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(gen.statusCode).toBe(200)
    const key = gen.json().key

    const view = await inject({ method: 'GET', url: `/api/parent/${key}` })
    expect(view.statusCode).toBe(200)
    const data = view.json()
    expect(data.class_name).toBe('高二6班')
    // 脱敏：不出现完整姓名「陈一」，出现「陈+首字母」
    expect(JSON.stringify(data)).not.toContain('陈一')
    expect(JSON.stringify(data)).toContain('陈')

    // 无效 key 404
    const bad = await inject({ method: 'GET', url: '/api/parent/wrongkey' })
    expect(bad.statusCode).toBe(404)
  })
})
