-- 家长留言板块：家长凭 parent_key 链接留言，老师在消息页「家长留言」组回复（双向）。
-- 与班级聊天（老师 ↔ 值日生一体机）完全分离，仅共用消息页的两个群组入口。
CREATE TABLE parent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('parent','teacher')),
  sender_name TEXT NOT NULL,            -- 家长：脱敏孩子名+身份（如 张S妈妈）；老师：教师姓名
  actor_student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,  -- 家长留言关联的孩子
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,              -- 老师回复关联的账号
  body TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_parent_messages_class ON parent_messages (class_id, id);
