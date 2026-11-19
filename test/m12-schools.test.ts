import { describe, expect, it } from 'vitest'
import { createTestCtx } from './helpers.js'

const { inject, db } = createTestCtx()
const qget = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any
const qall = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[]

describe('多校/年级账户体系', () => {
  let platformToken: string
  let schoolId: number
  let schoolAdminToken: string
  let zhangId: number
  let zhangToken: string
  let gradeId: number
  let classId: number
  let otherTeacherToken: string

  it('准备：平台超管 + 回填校验', async () => {
    platformToken = (
      await inject({
        method: 'POST',
        url: '/api/auth/activate',
        payload: { code: 'TESTBOOT', name: '平台管理员', password: 'admin123' },
      })
    ).json().token

    // 迁移回填：默认学校存在
    const schools = qall('SELECT * FROM schools')
    expect(schools).toHaveLength(1)
    expect(schools[0].name).toBe('默认学校')

    // 平台超管：admin + schoolId NULL
    const me = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${platformToken}` },
    })
    expect(me.json().user.schoolId).toBeNull()
  })

  it('建学校 + 首任校管理员；校管理员登录可见学校', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/admin/schools',
      payload: { name: '实验中学', admin_name: '王校长', admin_password: 'pass1234' },
      headers: { authorization: `Bearer ${platformToken}` },
    })
    expect(res.statusCode).toBe(200)
    schoolId = res.json().school.id
    expect(res.json().admin.name).toBe('王校长')

    const dup = await inject({
      method: 'POST',
      url: '/api/admin/schools',
      payload: { name: '实验中学' },
      headers: { authorization: `Bearer ${platformToken}` },
    })
    expect(dup.statusCode).toBe(400)

    const login = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: '王校长', password: 'pass1234' },
    })
    schoolAdminToken = login.json().token
    expect(login.json().user.role).toBe('admin')
    expect(login.json().user.schoolId).toBe(schoolId)

    // 校管理员不能访问平台接口
    const forbidden = await inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${schoolAdminToken}` },
    })
    expect(forbidden.statusCode).toBe(403)
  })

  it('校管理员：建教师/年级/班级/主任', async () => {
    zhangId = (
      await inject({
        method: 'POST',
        url: '/api/school/teachers',
        payload: { name: '张老师', password: 'teach123' },
        headers: { authorization: `Bearer ${schoolAdminToken}` },
      })
    ).json().user.id
    expect(zhangId).toBeTruthy()

    const row = qget('SELECT school_id FROM users WHERE id = ?', zhangId)
    expect(row.school_id).toBe(schoolId)

    gradeId = (
      await inject({
        method: 'POST',
        url: '/api/school/grades',
        payload: { name: '高二' },
        headers: { authorization: `Bearer ${schoolAdminToken}` },
      })
    ).json().grade.id

    classId = (
      await inject({
        method: 'POST',
        url: '/api/school/classes',
        payload: { name: '6班', grade_id: gradeId, teacher_id: zhangId },
        headers: { authorization: `Bearer ${schoolAdminToken}` },
      })
    ).json().class.id
    expect(classId).toBeTruthy()

    const cls = qget('SELECT school_id, grade_id FROM classes WHERE id = ?', classId)
    expect(cls.school_id).toBe(schoolId)
    expect(cls.grade_id).toBe(gradeId)

    const dir = await inject({
      method: 'PUT',
      url: `/api/school/grades/${gradeId}/directors`,
      payload: { user_ids: [zhangId] },
      headers: { authorization: `Bearer ${schoolAdminToken}` },
    })
    expect(dir.statusCode).toBe(200)

    const overview = await inject({
      method: 'GET',
      url: '/api/school/overview',
      headers: { authorization: `Bearer ${schoolAdminToken}` },
    })
    expect(overview.json().school.name).toBe('实验中学')
    expect(overview.json().teachers).toHaveLength(1)
    expect(overview.json().grades[0].directors).toContain('张老师')
    expect(overview.json().classes).toHaveLength(1)
  })

  it('校邀请码激活 → 教师入本校；平台邀请教师 → 默认学校', async () => {
    const inv = (
      await inject({
        method: 'POST',
        url: '/api/school/invites',
        payload: { role: 'teacher' },
        headers: { authorization: `Bearer ${schoolAdminToken}` },
      })
    ).json().code
    const act = await inject({
      method: 'POST',
      url: '/api/auth/activate',
      payload: { code: inv, name: '刘老师', password: 'teach123' },
    })
    expect(act.statusCode).toBe(200)
    const row = qget('SELECT school_id FROM users WHERE name = ?', '刘老师')
    expect(row.school_id).toBe(schoolId)

    // 平台超管发不带学校的教师邀请 → 默认学校
    const pInv = (
      await inject({
        method: 'POST',
        url: '/api/admin/invites',
        payload: { role: 'teacher' },
        headers: { authorization: `Bearer ${platformToken}` },
      })
    ).json().code
    await inject({
      method: 'POST',
      url: '/api/auth/activate',
      payload: { code: pInv, name: '外校老师', password: 'teach123' },
    })
    otherTeacherToken = (
      await inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { name: '外校老师', password: 'teach123' },
      })
    ).json().token
    const other = qget('SELECT school_id FROM users WHERE name = ?', '外校老师')
    expect(other.school_id).not.toBe(schoolId)
  })

  it('年级主任只读汇总：考勤聚合正确；非主任 403', async () => {
    zhangToken = (
      await inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { name: '张老师', password: 'teach123' },
      })
    ).json().token

    const stu = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/students`,
      payload: { name: '陈一' },
      headers: { authorization: `Bearer ${zhangToken}` },
    })
    const stuId = stu.json().student.id
    const stu2 = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/students`,
      payload: { name: '丁二' },
      headers: { authorization: `Bearer ${zhangToken}` },
    })
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/attendance`,
      payload: {
        day: '2026-11-19',
        entries: [
          { student_id: stuId, slot: 'morning', status: 'late' },
          { student_id: stuId, slot: 'noon', status: 'late' }, // 同日同状态按天去重 → 迟到 1 人
          { student_id: stu2.json().student.id, slot: 'morning', status: 'absent' },
        ],
      },
      headers: { authorization: `Bearer ${zhangToken}` },
    })
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/hw-tasks`,
      payload: { day: '2026-11-19', subject: '数学', content: '练习册 P1' },
      headers: { authorization: `Bearer ${zhangToken}` },
    })

    const sum = await inject({
      method: 'GET',
      url: `/api/grades/${gradeId}/summary?day=2026-11-19`,
      headers: { authorization: `Bearer ${zhangToken}` },
    })
    expect(sum.statusCode).toBe(200)
    const cl = sum.json().classes[0]
    expect(cl.name).toBe('6班')
    expect(cl.student_count).toBe(2)
    expect(cl.late).toBe(1)
    expect(cl.absent).toBe(1)
    expect(cl.present).toBe(0)
    expect(cl.tasks[0].subject).toBe('数学')

    // 非主任教师 403
    const other = await inject({
      method: 'GET',
      url: `/api/grades/${gradeId}/summary`,
      headers: { authorization: `Bearer ${otherTeacherToken}` },
    })
    expect(other.statusCode).toBe(403)

    // 校管理员/平台超管可看汇总
    const viaAdmin = await inject({
      method: 'GET',
      url: `/api/grades/${gradeId}/summary`,
      headers: { authorization: `Bearer ${schoolAdminToken}` },
    })
    expect(viaAdmin.statusCode).toBe(200)
    const viaPlatform = await inject({
      method: 'GET',
      url: `/api/grades/${gradeId}/summary`,
      headers: { authorization: `Bearer ${platformToken}` },
    })
    expect(viaPlatform.statusCode).toBe(200)
  })

  it('教师自助建班：落本校 + 年级 find-or-create', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/classes',
      payload: { name: '7班', grade: '高二' },
      headers: { authorization: `Bearer ${zhangToken}` },
    })
    expect(res.statusCode).toBe(200)
    const cls = res.json().class
    expect(cls.school_id).toBe(schoolId)
    expect(cls.grade_id).toBe(gradeId) // 复用已有「高二」
    const grades = qall('SELECT name FROM grades WHERE school_id = ?', schoolId)
    expect(grades).toHaveLength(1)

    // 外校教师建班 → 归其学校（默认学校）
    const otherCls = await inject({
      method: 'POST',
      url: '/api/classes',
      payload: { name: '外校班' },
      headers: { authorization: `Bearer ${otherTeacherToken}` },
    })
    expect(otherCls.json().class.school_id).not.toBe(schoolId)
  })

  it('协作教师跨校限制', async () => {
    const otherId = (
      await inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${otherTeacherToken}` },
      })
    ).json().user.id
    const res = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/teachers`,
      payload: { user_id: otherId },
      headers: { authorization: `Bearer ${zhangToken}` },
    })
    expect(res.statusCode).toBe(400)

    // 候选教师仅本校：外校老师不在列
    const av = await inject({
      method: 'GET',
      url: `/api/classes/${classId}/available-teachers`,
      headers: { authorization: `Bearer ${zhangToken}` },
    })
    const names = av.json().teachers.map((t: any) => t.name)
    expect(names).not.toContain('外校老师')
    expect(names).toContain('刘老师')
  })

  it('班级列表按校隔离', async () => {
    const schoolList = await inject({
      method: 'GET',
      url: '/api/classes',
      headers: { authorization: `Bearer ${schoolAdminToken}` },
    })
    expect(schoolList.json().classes.every((cl: any) => cl.school_id === schoolId)).toBe(true)
    expect(schoolList.json().classes.some((cl: any) => cl.name === '外校班')).toBe(false)

    const all = await inject({
      method: 'GET',
      url: '/api/classes',
      headers: { authorization: `Bearer ${platformToken}` },
    })
    expect(all.json().classes.some((cl: any) => cl.name === '外校班')).toBe(true)
  })

  it('平台超管发指定学校邀请；审计按校过滤', async () => {
    const inv = (
      await inject({
        method: 'POST',
        url: '/api/admin/invites',
        payload: { role: 'teacher', school_id: schoolId },
        headers: { authorization: `Bearer ${platformToken}` },
      })
    ).json()
    expect(inv.school_id).toBe(schoolId)

    const act = await inject({
      method: 'POST',
      url: '/api/auth/activate',
      payload: { code: inv.code, name: '赵老师', password: 'teach123' },
    })
    const row = qget('SELECT school_id FROM users WHERE name = ?', '赵老师')
    expect(row.school_id).toBe(schoolId)

    const auditList = await inject({
      method: 'GET',
      url: '/api/school/audit',
      headers: { authorization: `Bearer ${schoolAdminToken}` },
    })
    expect(auditList.statusCode).toBe(200)
    expect(auditList.json().logs.length).toBeGreaterThan(0)
  })
})
