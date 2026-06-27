import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';

/**
 * Open a SQLite database.
 *
 * Pass `:memory:` for an ephemeral in-process database (used by tests), or a
 * filesystem path for a durable database. Foreign keys and recursive CTEs are
 * always enabled — both are required by the C1 schema (parent/child FK
 * constraints and unlimited-depth subtree fetch).
 */
export function openDatabase(path: string): BetterSqliteDatabase {
  const db = new Database(path);
  // WAL is ignored for `:memory:` databases; harmless to set.
  db.pragma('journal_mode = WAL');
  // Enforce foreign keys so parent/child and workspace-boundary FKs are live.
  db.pragma('foreign_keys = ON');
  return db;
}

export type { BetterSqliteDatabase };
