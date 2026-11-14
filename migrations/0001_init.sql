-- 班级中心初始 schema（自 Node/better-sqlite3 版本迁移，与原 schema 完全一致）
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('teacher','admin')),
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'teacher',
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE invite_codes (
  code TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('teacher','admin')),
  used_by INTEGER REFERENCES users(id),
  used_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  grade TEXT NOT NULL DEFAULT '',
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  student_pass_hash TEXT,
  subjects_json TEXT NOT NULL DEFAULT '["语文","数学","英语","物理","化学","政治","其他"]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  legacy_sync_code TEXT
);

CREATE TABLE students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  seq INTEGER NOT NULL,
  pinyin_initial TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (class_id, seq)
);

CREATE TABLE attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('morning','noon','evening')),
  status TEXT NOT NULL CHECK (status IN ('present','leave','late','absent','violate')),
  note TEXT NOT NULL DEFAULT '',
  updated_by_role TEXT NOT NULL CHECK (updated_by_role IN ('teacher','student','admin')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (class_id, day, student_id, slot)
);

CREATE TABLE leaves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  from_day TEXT NOT NULL,
  to_day TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE homework_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  subject TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  missing_json TEXT NOT NULL DEFAULT '[]',
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (class_id, day, subject)
);

CREATE TABLE homework_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  subject TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (class_id, day, subject)
);

CREATE TABLE duty_roster (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL DEFAULT 0,
  UNIQUE (class_id, week_start, weekday, student_id)
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL CHECK (actor IN ('teacher','student','admin')),
  actor_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_attendance_class_day ON attendance (class_id, day);
CREATE INDEX idx_hw_records_class_day ON homework_records (class_id, day);
CREATE INDEX idx_hw_tasks_class_day ON homework_tasks (class_id, day);
CREATE INDEX idx_audit_class_ts ON audit_logs (class_id, ts);
