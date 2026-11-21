-- 考试成绩板块：考试 + 逐科成绩（每科一行，空分=缺考）+ AI 评语存库。
-- 口径：及格=满分×60%、优秀=满分×85%；停用学生历史成绩自然保留；大板/学生端永不显示成绩。
CREATE TABLE exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  day TEXT NOT NULL,
  subjects_json TEXT NOT NULL DEFAULT '[]',   -- [{"subject":"语文","full":150},...]
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_exams_class ON exams (class_id, day);

CREATE TABLE exam_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  score REAL,                                  -- NULL = 缺考/未录
  full_score REAL NOT NULL DEFAULT 100,
  UNIQUE (exam_id, student_id, subject)
);

CREATE INDEX idx_exam_scores_exam ON exam_scores (exam_id, student_id);

CREATE TABLE exam_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (exam_id, student_id)
);
