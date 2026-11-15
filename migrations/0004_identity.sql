-- T2 轻量学生身份：操作留痕到人
ALTER TABLE messages ADD COLUMN actor_student_id INTEGER REFERENCES students(id) ON DELETE SET NULL;
ALTER TABLE leaves ADD COLUMN actor_student_id INTEGER REFERENCES students(id);
ALTER TABLE attendance ADD COLUMN actor_student_id INTEGER REFERENCES students(id) ON DELETE SET NULL;
ALTER TABLE homework_records ADD COLUMN actor_student_id INTEGER REFERENCES students(id) ON DELETE SET NULL;

-- 多教师协作
CREATE TABLE class_teachers (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (class_id, user_id)
);
