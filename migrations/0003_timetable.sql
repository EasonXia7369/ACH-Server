-- 课程表：班级 × 星期 × 节次
CREATE TABLE timetable (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  period INTEGER NOT NULL CHECK (period BETWEEN 1 AND 12),
  subject TEXT NOT NULL DEFAULT '',
  teacher TEXT NOT NULL DEFAULT '',
  UNIQUE (class_id, weekday, period)
);

CREATE INDEX idx_timetable_class ON timetable (class_id, weekday);
