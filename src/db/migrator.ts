import type { BetterSqliteDatabase } from './connection.js';

/**
 * A single migration. `up` creates/alters schema; `down` reverses it so a fresh
 * database can return to a clean state. Both run inside a transaction enforced
 * by the runner.
 */
export interface Migration {
  /** Stable version id, monotonically increasing. Stored in schema_migrations. */
  readonly version: number;
  /** Human-readable name for diagnostics. */
  readonly name: string;
  /** Forward DDL/DML. Must be reversible by `down`. */
  readonly up: readonly string[];
  /** Reverse of `up`. Drops tables/constraints created by `up`. */
  readonly down: readonly string[];
}

/**
 * Apply pending migrations in version order. Each migration runs in its own
 * transaction; the `schema_migrations` row is committed together with its DDL
 * so a failed migration never leaves a phantom "applied" row.
 */
export function migrateUp(db: BetterSqliteDatabase, migrations: readonly Migration[]): number[] {
  ensureMigrationsTable(db);
  const applied = appliedVersions(db);
  const pending = [...migrations]
    .filter((m) => !applied.has(m.version))
    .sort((a, b) => a.version - b.version);

  const newlyApplied: number[] = [];
  for (const migration of pending) {
    // DDL under foreign_keys=ON can fail when dropping/recreating tables with
    // cross-table references. PRAGMA foreign_keys is a no-op inside a
    // transaction, so toggle it outside the txn wrapper.
    const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
    if (fkWasOn) db.pragma('foreign_keys = OFF');
    try {
      const run = db.transaction(() => {
        for (const stmt of migration.up) {
          db.exec(stmt);
        }
        db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
          migration.version,
          migration.name,
        );
      });
      run();
    } finally {
      if (fkWasOn) db.pragma('foreign_keys = ON');
    }
    newlyApplied.push(migration.version);
  }
  return newlyApplied;
}

/**
 * Roll back migrations down to (and including) `targetVersion`. If
 * `targetVersion` is omitted, rolls back the most recently applied migration.
 * Migrations are rolled back in reverse version order, each in its own
 * transaction, dropping its `schema_migrations` row together with its DDL.
 *
 * Returns the versions that were rolled back.
 */
export function migrateDown(
  db: BetterSqliteDatabase,
  migrations: readonly Migration[],
  targetVersion?: number,
): number[] {
  ensureMigrationsTable(db);
  const applied = [...appliedVersions(db)].sort((a, b) => b - a);
  if (applied.length === 0) return [];

  const byVersion = new Map(migrations.map((m) => [m.version, m]));

  let toRollback: number[];
  if (targetVersion === undefined) {
    const latest = applied[0];
    if (latest === undefined) {
      throw new Error('migrateDown: no applied migrations to roll back');
    }
    toRollback = [latest];
  } else {
    const idx = applied.indexOf(targetVersion);
    if (idx === -1) {
      throw new Error(`migrateDown: version ${targetVersion} is not applied`);
    }
    toRollback = applied.slice(0, idx + 1);
  }

  const rolledBack: number[] = [];
  for (const version of toRollback) {
    const migration = byVersion.get(version);
    if (!migration) {
      throw new Error(`migrateDown: no migration registered for version ${version}`);
    }
    const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
    if (fkWasOn) db.pragma('foreign_keys = OFF');
    try {
      const run = db.transaction(() => {
        for (const stmt of migration.down) {
          db.exec(stmt);
        }
        db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(version);
      });
      run();
    } finally {
      if (fkWasOn) db.pragma('foreign_keys = ON');
    }
    rolledBack.push(version);
  }
  return rolledBack;
}

/** Returns the set of applied migration versions. */
export function appliedMigrations(db: BetterSqliteDatabase): number[] {
  ensureMigrationsTable(db);
  return [...appliedVersions(db)].sort((a, b) => a - b);
}

function ensureMigrationsTable(db: BetterSqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name    TEXT    NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function appliedVersions(db: BetterSqliteDatabase): Set<number> {
  const rows = db
    .prepare('SELECT version FROM schema_migrations')
    .all() as { version: number }[];
  return new Set(rows.map((r) => r.version));
}
