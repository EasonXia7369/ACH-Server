-- 消息撤回/删除 + 弹大屏开关 + 快捷短语配置 + 家长只读链接
ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN popup INTEGER NOT NULL DEFAULT 1;

CREATE TABLE quick_phrases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  UNIQUE (class_id, content)
);

ALTER TABLE classes ADD COLUMN parent_key TEXT;
