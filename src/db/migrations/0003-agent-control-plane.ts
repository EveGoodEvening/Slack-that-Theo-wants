import type { Migration } from '../migrator.js';

/**
 * C7 agent identity and API control-plane persistent structures.
 *
 * C7 does NOT redefine the C1 actor schema. Agent identity reuses the existing
 * `actor` table with `kind = 'agent'`. This migration adds only the agent-
 * specific control-plane structures on top of it:
 *
 * - `agent_profile`: agent-specific profile/metadata fields keyed by the actor
 *   id (1:1 with `actor` rows where `kind = 'agent'`). Keeps the C1 actor
 *   schema untouched while giving agents a place for description, status, and
 *   capabilities metadata.
 * - `agent_credential`: scoped API tokens / service credentials for agents.
 *   Stored HASHED (never plaintext). A credential is scoped to a single
 *   workspace via the actor's workspace. Supports rotation (new row, old row
 *   revoked) and revocation (status flip). The plaintext secret is shown only
 *   once at issuance and is never persisted.
 * - `agent_audit_log`: append-only audit records for agent write actions
 *   (create post / comment / reply). Captures actor, workspace, action,
 *   target, idempotency key, and timestamp.
 * - `agent_idempotency_key`: durable idempotency key store for agent writes.
 *   Records the request key, actor, action, and the resulting target id + a
 *   digest of the request payload, so a replayed write returns the original
 *   result instead of creating a duplicate (and an extra feed bump).
 * - `agent_quota_state`: per-(actor, window) counter for rate-limit / quota
 *   enforcement. The window is a rolling bucket key (e.g. per-minute or
 *   per-hour) so the counter can be reset by rotating the bucket key.
 *
 * All tables are workspace-scoped through the actor FK and inherit the C1
 * workspace-boundary composite FK so a credential/quota/audit row cannot
 * reference an actor in another workspace.
 */
export const migration0003AgentControlPlane: Migration = {
  version: 3,
  name: 'agent-control-plane',
  up: [
    `
    CREATE TABLE agent_profile (
      actor_id      TEXT PRIMARY KEY NOT NULL,
      description   TEXT,
      status        TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'revoked')),
      capabilities  TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      -- Profile must belong to an agent actor. Enforced by a CHECK against a
      -- subquery is not allowed in SQLite CHECK, so a trigger guards this.
      CHECK (actor_id IS NOT NULL)
    );
    `,
    `
    CREATE TRIGGER enforce_agent_profile_kind
    AFTER INSERT ON agent_profile
    FOR EACH ROW
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM actor a WHERE a.id = NEW.actor_id AND a.kind = 'agent'
        )
        THEN RAISE(ABORT, 'agent_profile may only reference an agent actor')
      END;
    END;
    `,
    `
    CREATE TRIGGER enforce_agent_profile_kind_update
    AFTER UPDATE OF actor_id ON agent_profile
    FOR EACH ROW
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM actor a WHERE a.id = NEW.actor_id AND a.kind = 'agent'
        )
        THEN RAISE(ABORT, 'agent_profile may only reference an agent actor')
      END;
    END;
    `,
    `
    CREATE TABLE agent_credential (
      id              TEXT PRIMARY KEY NOT NULL,
      actor_id        TEXT NOT NULL,
      workspace_id    TEXT NOT NULL,
      -- Scrypt hash of the plaintext secret (format: salt$hash). The plaintext
      -- is NEVER stored; this column contains only non-reversible verifier
      -- material.
      secret_hash     TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'revoked')),
      label           TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at      TEXT,
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
      -- Credential must belong to an agent actor in this workspace.
      FOREIGN KEY (workspace_id, actor_id)
        REFERENCES actor (workspace_id, id) ON DELETE CASCADE,
      CHECK (secret_hash IS NOT NULL)
    );
    `,
    `
    CREATE TRIGGER enforce_agent_credential_kind
    AFTER INSERT ON agent_credential
    FOR EACH ROW
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM actor a
          WHERE a.id = NEW.actor_id
            AND a.workspace_id = NEW.workspace_id
            AND a.kind = 'agent'
        )
        THEN RAISE(ABORT, 'agent_credential may only reference an agent actor in its workspace')
      END;
    END;
    `,
    `
    CREATE TRIGGER enforce_agent_credential_kind_update
    AFTER UPDATE OF actor_id, workspace_id ON agent_credential
    FOR EACH ROW
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM actor a
          WHERE a.id = NEW.actor_id
            AND a.workspace_id = NEW.workspace_id
            AND a.kind = 'agent'
        )
        THEN RAISE(ABORT, 'agent_credential may only reference an agent actor in its workspace')
      END;
    END;
    `,
    'CREATE INDEX idx_agent_credential_actor ON agent_credential (actor_id);',
    'CREATE INDEX idx_agent_credential_workspace ON agent_credential (workspace_id);',
    `
    CREATE TABLE agent_audit_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      actor_id        TEXT NOT NULL,
      workspace_id    TEXT NOT NULL,
      action          TEXT NOT NULL CHECK (action IN ('create_post','create_comment','create_reply')),
      target_id       TEXT NOT NULL,
      root_post_id    TEXT,
      idempotency_key TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
      FOREIGN KEY (workspace_id, actor_id)
        REFERENCES actor (workspace_id, id) ON DELETE CASCADE
    );
    `,
    'CREATE INDEX idx_agent_audit_actor ON agent_audit_log (actor_id, created_at);',
    'CREATE INDEX idx_agent_audit_workspace ON agent_audit_log (workspace_id, created_at);',
    `
    CREATE TABLE agent_idempotency_key (
      key             TEXT NOT NULL,
      actor_id        TEXT NOT NULL,
      workspace_id    TEXT NOT NULL,
      action          TEXT NOT NULL CHECK (action IN ('create_post','create_comment','create_reply')),
      target_id       TEXT NOT NULL,
      request_digest  TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (key, actor_id, action),
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
      FOREIGN KEY (workspace_id, actor_id)
        REFERENCES actor (workspace_id, id) ON DELETE CASCADE
    );
    `,
    'CREATE INDEX idx_agent_idempotency_actor ON agent_idempotency_key (actor_id, created_at);',
    `
    CREATE TABLE agent_quota_state (
      actor_id        TEXT NOT NULL,
      workspace_id    TEXT NOT NULL,
      bucket_key      TEXT NOT NULL,
      count           INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (actor_id, bucket_key),
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
      FOREIGN KEY (workspace_id, actor_id)
        REFERENCES actor (workspace_id, id) ON DELETE CASCADE,
      CHECK (count >= 0)
    );
    `,
  ],
  down: [
    'DROP TABLE IF EXISTS agent_quota_state;',
    'DROP INDEX IF EXISTS idx_agent_idempotency_actor;',
    'DROP TABLE IF EXISTS agent_idempotency_key;',
    'DROP INDEX IF EXISTS idx_agent_audit_workspace;',
    'DROP INDEX IF EXISTS idx_agent_audit_actor;',
    'DROP TABLE IF EXISTS agent_audit_log;',
    'DROP TRIGGER IF EXISTS enforce_agent_credential_kind_update;',
    'DROP TRIGGER IF EXISTS enforce_agent_credential_kind;',
    'DROP INDEX IF EXISTS idx_agent_credential_workspace;',
    'DROP INDEX IF EXISTS idx_agent_credential_actor;',
    'DROP TABLE IF EXISTS agent_credential;',
    'DROP TRIGGER IF EXISTS enforce_agent_profile_kind_update;',
    'DROP TRIGGER IF EXISTS enforce_agent_profile_kind;',
    'DROP TABLE IF EXISTS agent_profile;',
  ],
};
