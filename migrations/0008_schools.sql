-- 多校 / 年级账户体系
-- 设计：
--   schools：学校（租户）。自托管单校自动获得「默认学校」。
--   grades：年级（挂学校）；classes.grade_id 关联，grade 文本字段保留为冗余展示。
--   角色模型（复用现有 role 字段，不重建表）：
--     users.role='admin' + school_id NULL  → 平台超管（原有 admin 语义）
--     users.role='admin' + school_id 非空  → 校管理员（仅本校范围）
--     users.role='teacher'                 → 教师（挂在某学校下）
--     grade_directors                      → 年级主任（教师身份的附加只读授权）
--   invite_codes.school_id：校管理员发的邀请绑定本校；NULL = 平台超管发的（激活归默认学校）。

CREATE TABLE schools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE grades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (school_id, name)
);

-- 年级主任（教师身份的附加授权；只读汇总）
CREATE TABLE grade_directors (
  grade_id INTEGER NOT NULL REFERENCES grades(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (grade_id, user_id)
);

ALTER TABLE users ADD COLUMN school_id INTEGER REFERENCES schools(id);
ALTER TABLE invite_codes ADD COLUMN school_id INTEGER REFERENCES schools(id);
ALTER TABLE classes ADD COLUMN school_id INTEGER REFERENCES schools(id);
ALTER TABLE classes ADD COLUMN grade_id INTEGER REFERENCES grades(id);

-- 回填：默认学校 + 现有数据归属
INSERT INTO schools (name) VALUES ('默认学校');

-- 现有教师归默认学校；admin 保持 school_id NULL（平台超管）
UPDATE users SET school_id = (SELECT MIN(id) FROM schools) WHERE role = 'teacher';
-- 未使用的教师邀请码归默认学校（激活后进默认学校）
UPDATE invite_codes SET school_id = (SELECT MIN(id) FROM schools)
  WHERE role = 'teacher' AND used_by IS NULL AND school_id IS NULL;

UPDATE classes SET school_id = (SELECT MIN(id) FROM schools);
-- 已有 grade 文本去重建年级（空文本班级保持 grade_id NULL = 未分组）
INSERT INTO grades (school_id, name, sort)
  SELECT (SELECT MIN(id) FROM schools), grade, 0 FROM classes WHERE grade != '' GROUP BY grade;
UPDATE classes SET grade_id = (
  SELECT g.id FROM grades g WHERE g.school_id = classes.school_id AND g.name = classes.grade
);

CREATE INDEX idx_classes_school ON classes (school_id);
CREATE INDEX idx_grades_school ON grades (school_id);
CREATE INDEX idx_users_school ON users (school_id);
