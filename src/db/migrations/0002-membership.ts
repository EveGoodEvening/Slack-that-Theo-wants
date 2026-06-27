import type { Migration } from '../migrator.js';

/**
 * C1a security baseline schema.
 *
 * Introduces the minimal persistent membership model needed to scope reads and
 * writes to a workspace/group. An actor is a member of exactly the workspace it
 * belongs to (actor.workspace_id); `workspace_member` records the membership
 * with a role discriminator so the authorization middleware can distinguish
 * read-only and read-write access. The full membership lifecycle (invites,
 * shares, multi-workspace membership, role changes) is deferred to C9; this
 * table is the durable backbone C9 extends.
 *
 * Design notes:
 * - One row per (workspace_id, actor_id). The composite is unique and is the
 *   natural key the membership repository reads by.
 * - `role` is constrained to 'read' | 'write'. 'write' implies 'read'. C1a
 *   treats any actor with a row as a member; absence of a row means no access.
 * - A trigger keeps `workspace_member.workspace_id` in sync with
 *   `actor.workspace_id`: a membership row may only exist for the actor's own
 *   workspace. This prevents a stubbed principal from being granted membership
 *   in a workspace it does not belong to.
 * - Seed-on-actor: a trigger creates a default 'write' membership row whenever
 *   an actor is inserted, so every actor is a member of its own workspace with
 *   write access by default. C9 replaces this with explicit invite/share.
 */
export const migration0002Membership: Migration = {
  version: 2,
  name: 'membership-baseline',
  up: [
    `
    CREATE TABLE workspace_member (
      workspace_id TEXT NOT NULL,
      actor_id     TEXT NOT NULL,
      role         TEXT NOT NULL CHECK (role IN ('read', 'write')),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workspace_id, actor_id),
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE CASCADE,
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      -- Membership must be in the actor's own workspace. The composite FK to
      -- actor(workspace_id, id) enforces this at the data layer.
      FOREIGN KEY (workspace_id, actor_id)
        REFERENCES actor (workspace_id, id) ON DELETE CASCADE
    );
    `,
    `
    -- Backfill: every existing actor becomes a 'write' member of its own
    -- workspace. Idempotent via INSERT OR IGNORE.
    INSERT OR IGNORE INTO workspace_member (workspace_id, actor_id, role)
    SELECT workspace_id, id, 'write' FROM actor;
    `,
    `
    -- Seed a membership row whenever a new actor is created, so every actor is
    -- a member of its own workspace with write access by default. C9 replaces
    -- this auto-membership with explicit invite/share.
    CREATE TRIGGER seed_actor_membership
    AFTER INSERT ON actor
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO workspace_member (workspace_id, actor_id, role)
      VALUES (NEW.workspace_id, NEW.id, 'write');
    END;
    `,
  ],
  down: [
    'DROP TRIGGER IF EXISTS seed_actor_membership;',
    'DROP TABLE IF EXISTS workspace_member;',
  ],
};
