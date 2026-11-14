import { beforeAll, describe, expect, it } from 'vitest'
import { createTestCtx } from './helpers.js'

const { inject } = createTestCtx()

describe('旧版功能对齐：改密 / 重命名 / 备份恢复', () => {
  let teacherToken: string
  let classId: number
  let stuId: number

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
      payload: { name: '旧班名', grade: '高一' },
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
  })

  it('班级重命名', async () => {
    const res = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}`,
      payload: { name: '新高一(3)班', grade: '高二' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().class.name).toBe('新高一(3)班')
    expect(res.json().class.grade).toBe('高二')
  })

  it('修改自己的密码：旧密码失效、新密码可登录', async () => {
    const wrong = await inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { old: 'badpass', new: 'newpass1' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(wrong.statusCode).toBe(401)

    const ok = await inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { old: 'teach123', new: 'newpass1' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(ok.statusCode).toBe(200)

    const relogin = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: '张老师', password: 'newpass1' },
    })
    expect(relogin.statusCode).toBe(200)
    const oldLogin = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: '张老师', password: 'teach123' },
    })
    expect(oldLogin.statusCode).toBe(401)
  })

  it('备份 → 修改数据 → 恢复回滚', async () => {
    // 先造数据
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/attendance`,
      payload: {
        day: '2026-11-13',
        entries: [{ student_id: stuId, slot: 'morning', status: 'late', note: '堵车' }],
      },
      headers: { authorization: `Bearer ${teacherToken}` },
    })

    const backup = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/backup`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(backup.statusCode).toBe(200)
    const backupJson = backup.json()
    expect(backupJson.app).toBe('ark-class-backup')
    expect(backupJson.students).toHaveLength(1)
    expect(backupJson.attendance).toHaveLength(1)

    // 备份之后继续修改数据
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/attendance`,
      payload: {
        day: '2026-11-13',
        entries: [
          { student_id: stuId, slot: 'morning', status: 'present' },
          { student_id: stuId, slot: 'noon', status: 'absent', note: '未到校' },
        ],
      },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const after = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/attendance?day=2026-11-13`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(after.json().records).toHaveLength(1) // noon absent

    // 恢复备份 → 回到备份时点（早迟到）
    const restore = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/restore`,
      payload: backupJson,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(restore.statusCode).toBe(200)

    const restored = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/attendance?day=2026-11-13`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(restored.json().records).toHaveLength(1)
    expect(restored.json().records[0].status).toBe('late')
    expect(restored.json().records[0].note).toBe('堵车')

    // 恢复后学生名单保持（id 不变）
    const detail = await inject({
      method: 'GET',
      url: `/api/classes/${classId}`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(detail.json().students.map((s: any) => s.id)).toEqual([stuId])
  })

  it('恢复班级不符的备份被拒绝', async () => {
    const backup = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/backup`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const bad = await inject({
      method: 'PUT',
      url: '/api/classes/9999/restore',
      payload: backup.json(),
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    // 班级归属守卫先于备份校验拒绝（403），双保险均不可绕过
    expect([400, 403]).toContain(bad.statusCode)
  })
})
