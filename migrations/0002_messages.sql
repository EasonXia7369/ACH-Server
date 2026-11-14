-- 消息板块：班级群（班主任 ↔ 值日生一体机）
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('teacher','student')),
  kind TEXT NOT NULL CHECK (kind IN ('text','image','voice')),
  body TEXT NOT NULL DEFAULT '',
  media BLOB,
  media_mime TEXT,
  media_duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_messages_class_id ON messages (class_id, id);
