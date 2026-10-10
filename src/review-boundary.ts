import type { DatabaseSync } from 'node:sqlite';
const guards = new WeakMap<DatabaseSync, { allowed: boolean }>();
export function installReviewBoundary(db: DatabaseSync): void {
  if (guards.has(db)) return;
  const guard = { allowed: false }; guards.set(db, guard);
  db.function('acb_can_succeed', () => guard.allowed ? 1 : 0);
}
// Trusted core calls this only after resolving an opaque authorized caller.
export function withinAuthorizedReview<T>(db: DatabaseSync, operation: () => T): T {
  installReviewBoundary(db); const guard = guards.get(db)!;
  guard.allowed = true; try { return operation(); } finally { guard.allowed = false; }
}
