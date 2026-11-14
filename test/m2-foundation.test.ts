import { describe, expect, it } from 'vitest'
import { createTestCtx } from './helpers.js'

// 每个测试文件独立的内存库 + Hono app（替代原 fastify.inject + 临时 SQLite）
const { inject, db: testDb } = createTestCtx()

const legacy = {
  app: 'ark-legacy-export',
  version: 1,
  exportedAt: '2026-11-14T00:00:00.000Z',
  syncCode: 'ABC234',
  names: ['张三', '李四', '王五'],
  py: { 张: 'Z', 李: 'L', 王: 'W' },
  settings: {
    class_name: '高一(3)班',
    pass_hash: 'aabbcc',
    student_pass_hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    subjects: ['语文', '数学', '英语', '其他'],
  },
  attendance: [
    {
      day: '2026-11-12',
      payload: {
        s1: {
          morning: { status: 'late', note: '堵车' },
          noon: { status: 'present' },
        },
        s2: {
          morning: { status: 'leave', note: '病假' },
        },
      },
      updated_at: '2026-11-12T09:00:00.000Z',
    },
  ],
  hwRecords: [
    {
      day: '2026-11-12',
      subject: '数学',
      title: '练习册 P32',
      missing: ['s1', 's3'],
      deleted: false,
      updated_at: '2026-11-12T10:00:00.000Z',
    },
  ],
  hwTasks: [
    {
      day: '2026-11-12',
      subject: '语文',
      content: '背诵课文',
      deleted: false,
      updated_at: '2026-11-12T08:00:00.000Z',
    },
  ],
  logs: [
    { ts: '2026-11-12T09:00:00.000Z', usr: '老师', action: '考勤标记', detail: '张三 早 迟到' },
    { ts: '2026-11-12T10:00:00.000Z', usr: '学生', action: '作业登记', detail: '数学 2 人未交' },
  ],
}

describe('M2 数据地基全流程', () => {
  let adminToken: string
  let teacherToken: string
  let classId: number
  let inviteCode: string

  it('管理员引导码激活', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/auth/activate',
      payload: { code: 'TESTBOOT', name: '管理员', password: 'admin123' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.user.role).toBe('admin')
    adminToken = body.token
  })

  it('引导码不能再次使用（管理员已存在）', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/auth/activate',
      payload: { code: 'TESTBOOT', name: '第二个', password: 'x1234' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('管理员生成教师邀请码', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { role: 'teacher', days: 7 },
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(res.statusCode).toBe(200)
    inviteCode = res.json().code
  })

  it('教师用邀请码激活', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/auth/activate',
      payload: { code: inviteCode, name: '张老师', password: 'teach123' },
    })
    expect(res.statusCode).toBe(200)
    teacherToken = res.json().token
    expect(res.json().user.role).toBe('teacher')
  })

  it('邀请码不能重复使用', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/auth/activate',
      payload: { code: inviteCode, name: '冒名者', password: 'hack123' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('教师登录（密码可复用）', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: '张老师', password: 'teach123' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('教师建班并添加学生', async () => {
    const created = await inject({
      method: 'POST',
      url: '/api/classes',
      payload: { name: '高一(3)班', grade: '高一' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(created.statusCode).toBe(200)
    classId = created.json().class.id

    for (const name of ['陈一', '陈二', '陈三']) {
      const r = await inject({
        method: 'POST',
        url: `/api/classes/${classId}/students`,
        payload: { name },
        headers: { authorization: `Bearer ${teacherToken}` },
      })
      expect(r.statusCode).toBe(200)
    }

    const detail = await inject({
      method: 'GET',
      url: `/api/classes/${classId}`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(detail.json().students).toHaveLength(3)
    expect(detail.json().students.map((s: any) => s.seq)).toEqual([1, 2, 3])
  })

  it('其他教师（无邀请码）不能访问班级', async () => {
    // 管理员是 admin 角色，可以访问；用未登录用户验证 401
    const res = await inject({ method: 'GET', url: `/api/classes/${classId}` })
    expect(res.statusCode).toBe(401)
  })

  it('设置学生密码并 kiosk 登录', async () => {
    const set = await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/student-pass`,
      payload: { password: '1234' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(set.statusCode).toBe(200)

    const login = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/kiosk-login`,
      payload: { password: '1234' },
    })
    expect(login.statusCode).toBe(200)
    const me = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${login.json().token}` },
    })
    expect(me.json().user.role).toBe('student')
    expect(me.json().user.classId).toBe(classId)
  })

  it('错误学生密码被拒绝', async () => {
    const res = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/kiosk-login`,
      payload: { password: '9999' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('修改学生密码后旧一体机会话失效', async () => {
    const login = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/kiosk-login`,
      payload: { password: '1234' },
    })
    expect(login.statusCode).toBe(200)

    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/student-pass`,
      payload: { password: '5678' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })

    const me = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${login.json().token}` },
    })
    expect(me.statusCode).toBe(401)

    const relogin = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/kiosk-login`,
      payload: { password: '5678' },
    })
    expect(relogin.statusCode).toBe(200)
  })

  it('导入旧数据并校验映射', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/admin/import-legacy',
      payload: legacy,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(res.statusCode).toBe(200)
    const result = res.json()
    expect(result.studentCount).toBe(3)
    expect(result.attendanceRows).toBe(2) // present 不落盘
    expect(result.hwRecordRows).toBe(1)
    expect(result.hwTaskRows).toBe(1)
    expect(result.logRows).toBe(2)

    // 校验考勤映射：s2 李四 早 请假
    const sqlite = testDb
    const att = sqlite
      .prepare(
        `SELECT st.name, a.slot, a.status, a.note FROM attendance a
         JOIN students st ON st.id = a.student_id WHERE a.class_id = ? ORDER BY st.seq, a.slot`,
      )
      .all(result.classId) as any[]
    expect(att).toEqual([
      { name: '张三', slot: 'morning', status: 'late', note: '堵车' },
      { name: '李四', slot: 'morning', status: 'leave', note: '病假' },
    ])

    // 校验作业 missing 映射：s1 张三、s3 王五
    const hw = sqlite
      .prepare('SELECT missing_json FROM homework_records WHERE class_id = ?')
      .get(result.classId) as any
    const missingIds = JSON.parse(hw.missing_json)
    const names = sqlite
      .prepare(`SELECT name FROM students WHERE id IN (${missingIds.map(() => '?').join(',')})`)
      .all(...missingIds)
      .map((r: any) => r.name)
    expect(names.sort()).toEqual(['张三', '王五'].sort())

    // 校验审计日志角色
    const logs = sqlite
      .prepare('SELECT actor FROM audit_logs WHERE class_id = ? ORDER BY ts')
      .all(result.classId) as any[]
    expect(logs.map((l) => l.actor)).toEqual(['teacher', 'student', 'admin'])
  })

  it('同一同步码不能重复导入', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/admin/import-legacy',
      payload: legacy,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('学生令牌不能访问管理接口', async () => {
    const res = await inject({
      method: 'GET',
      url: '/api/admin/invites',
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(res.statusCode).toBe(200)
  })
})
