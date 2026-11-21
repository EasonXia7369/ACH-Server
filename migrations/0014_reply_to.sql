-- 家长留言引用回复：老师回复可指向某条家长留言（reply_to）。
-- 引用目标被删除时置空（软删后引用块仍显示"留言已删除"由前端处理，这里 SET NULL 简化）。
ALTER TABLE parent_messages ADD COLUMN reply_to INTEGER REFERENCES parent_messages(id) ON DELETE SET NULL;
