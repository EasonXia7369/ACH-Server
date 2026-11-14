export function audit(
  db: D1Database,
  classId: number | null,
  actor: 'teacher' | 'student' | 'admin',
  actorId: number | null,
  action: string,
  detail = '',
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO audit_logs (class_id, actor, actor_id, action, detail) VALUES (?,?,?,?,?)')
    .bind(classId, actor, actorId, action, detail)
}
