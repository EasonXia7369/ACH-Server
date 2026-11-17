-- Web Push 订阅：每台浏览器设备一条（endpoint 唯一）。
-- student 订阅绑定班级（class_id）；teacher/admin 订阅跟随用户（user_id），
-- 推送时按班级反查：本班学生订阅 + 该班教师订阅 + 全部管理员订阅。
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL DEFAULT '',
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_push_class ON push_subscriptions(class_id);
CREATE INDEX idx_push_user ON push_subscriptions(user_id);
