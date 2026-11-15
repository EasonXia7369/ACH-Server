import { describe, expect, it } from 'vitest'
import { createTestCtx } from './helpers.js'

const { inject } = createTestCtx()

describe('名单批量导入', () => {
  let teacherToken: string
  let classId: number

  it('准备：教师建班（班内已有陈一）', async () => {
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
    await inject({
      method: 'POST',
      url: `/api/classes/${classId}/students`,
      payload: { name: '陈一' },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(cls.statusCode).toBe(200)
  })

  it('批量导入：新增、跳过重复、学号顺延', async () => {
    const res = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/students/bulk`,
      payload: {
        students: [
          { name: '李小明', pinyin_initial: 'L' },
          { name: '陈一' }, // 与班内重复 → 跳过
          { name: '王小虎', pinyin_initial: 'W' },
          { name: '李小明' }, // 与本批重复 → 跳过
        ],
      },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().added).toBe(2)
    expect(res.json().skipped).toEqual(['陈一', '李小明'])
    expect(res.json().total).toBe(3)

    const detail = await inject({
      method: 'GET',
      url: `/api/classes/${classId}`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const students = detail.json().students
    expect(students).toHaveLength(3)
    expect(students.map((s: any) => s.seq)).toEqual([1, 2, 3])
    expect(students[1].name).toBe('李小明')
    expect(students[1].pinyin_initial).toBe('L')
    expect(students[2].name).toBe('王小虎')
  })

  it('空名单 / 超限被拒绝', async () => {
    const empty = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/students/bulk`,
      payload: { students: [] },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(empty.statusCode).toBe(400)

    const big = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/students/bulk`,
      payload: { students: Array.from({ length: 301 }, (_, i) => ({ name: `学生${i}` })) },
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(big.statusCode).toBe(400)
  })
})
