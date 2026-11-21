-- 班级码：6 位纯数字短码，家长在 /parent 入口页输码进入班级视图（与 parent_key 长链接并存）。
-- 全局唯一；允许为空（未生成的班继续用链接）；重置 = 换新码，旧码立即失效。
ALTER TABLE classes ADD COLUMN class_code TEXT;

CREATE UNIQUE INDEX idx_classes_code ON classes (class_code) WHERE class_code IS NOT NULL;
