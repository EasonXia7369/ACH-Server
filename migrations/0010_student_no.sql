-- 学生学号：家长凭学号在共享链接里绑定自己的孩子（个人化出勤视图 + 留言署名）。
-- 原样存文本（保住前导零等格式）；班级内唯一；允许为空（未录入时家长端回退名单下拉）。
ALTER TABLE students ADD COLUMN student_no TEXT;

CREATE UNIQUE INDEX idx_students_class_no ON students (class_id, student_no)
  WHERE student_no IS NOT NULL;
