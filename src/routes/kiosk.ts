import { Hono } from 'hono'
import type { AppContext } from '../types.js'

export const kioskRoutes = new Hono<AppContext>()

/** 一体机登录页需要班级列表（公开，只暴露 id 和名称） */
kioskRoutes.get('/api/kiosk/classes', async (c) => {
  const classes = (
    await c.env.DB.prepare(
      `SELECT c.id, c.name, (c.student_pass_hash IS NOT NULL) AS has_pass
       FROM classes c ORDER BY c.id`,
    ).all<any>()
  ).results
  return c.json({ classes })
})
