import type { Migration } from '../migrator.js';

/**
 * C9 auth, workspace boundaries, and collaboration base.
 *
 * Layers real local auth/session tables on top of the C1 actor model, relaxes
 * C1a membership so actors can be members of shared workspaces/groups, records
 * invite/share lifecycle state, and relaxes C7 agent control-plane tables so
 * credentials/audit/idempotency/quota follow the agent's membership workspace
 * rather than the actor's home workspace only.
 */
export const migration0004AuthCollaboration: Migration = {
  version: 4,
  name: 'auth-collaboration-base',
  up: [
    'DROP TRIGGER IF EXISTS enforce_no_insert_into_deleted_subtree;',
    'DROP TRIGGER IF EXISTS enforce_comment_workspace_consistency;',
    'DROP INDEX IF EXISTS idx_comment_workspace;',
    'DROP INDEX IF EXISTS idx_comment_parent;',
    'DROP INDEX IF EXISTS idx_comment_root;',
    'DROP INDEX IF EXISTS idx_post_feed;',
    'ALTER TABLE comment_node RENAME TO comment_node_c9_author_scope;',
    'ALTER TABLE post RENAME TO post_c9_author_scope;',
    `
    CREATE TABLE post (
      id               TEXT PRIMARY KEY NOT NULL,
      workspace_id     TEXT NOT NULL,
      author_actor_id  TEXT NOT NULL,
      content          TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity_at TEXT NOT NULL,
      deleted_at       TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
      FOREIGN KEY (author_actor_id) REFERENCES actor (id) ON DELETE RESTRICT,
      CHECK (last_activity_at IS NOT NULL)
    );
    `,
    'CREATE INDEX idx_post_feed ON post (workspace_id, last_activity_at DESC, id DESC);',
    `
    INSERT INTO post (id, workspace_id, author_actor_id, content, created_at, last_activity_at, deleted_at)
    SELECT id, workspace_id, author_actor_id, content, created_at, last_activity_at, deleted_at
    FROM post_c9_author_scope;
    `,
    `
    CREATE TABLE comment_node (
      id              TEXT PRIMARY KEY NOT NULL,
      workspace_id    TEXT NOT NULL,
      root_post_id    TEXT NOT NULL,
      parent_id       TEXT,
      author_actor_id TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at      TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
      FOREIGN KEY (root_post_id) REFERENCES post (id) ON DELETE RESTRICT,
      FOREIGN KEY (parent_id) REFERENCES comment_node (id) ON DELETE RESTRICT,
      FOREIGN KEY (author_actor_id) REFERENCES actor (id) ON DELETE RESTRICT,
      CHECK (workspace_id IS NOT NULL AND root_post_id IS NOT NULL),
      CHECK (parent_id IS NULL OR parent_id <> id)
    );
    `,
    'CREATE INDEX idx_comment_root ON comment_node (root_post_id, created_at, id);',
    'CREATE INDEX idx_comment_parent ON comment_node (parent_id, created_at, id);',
    'CREATE INDEX idx_comment_workspace ON comment_node (workspace_id);',
    `
    INSERT INTO comment_node (
      id, workspace_id, root_post_id, parent_id, author_actor_id, content, created_at, deleted_at
    )
    SELECT id, workspace_id, root_post_id, parent_id, author_actor_id, content, created_at, deleted_at
    FROM comment_node_c9_author_scope;
    `,
    'DROP TABLE comment_node_c9_author_scope;',
    'DROP TABLE post_c9_author_scope;',
    `
    CREATE TRIGGER enforce_comment_workspace_consistency
    BEFORE INSERT ON comment_node
    FOR EACH ROW
    BEGIN
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM post p WHERE p.id = NEW.root_post_id)
          AND NOT EXISTS (
            SELECT 1 FROM post p
            WHERE p.id = NEW.root_post_id AND p.workspace_id = NEW.workspace_id
          )
        THEN RAISE(ABORT, 'comment_node workspace_id must match its root post workspace')
      END;
      SELECT CASE
        WHEN NEW.parent_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM comment_node c WHERE c.id = NEW.parent_id)
          AND NOT EXISTS (
            SELECT 1 FROM comment_node c
            WHERE c.id = NEW.parent_id
              AND c.workspace_id = NEW.workspace_id
              AND c.root_post_id = NEW.root_post_id
          )
        THEN RAISE(ABORT, 'reply parent must share workspace and root post')
      END;
    END;
    `,
    `
    CREATE TRIGGER enforce_no_insert_into_deleted_subtree
    BEFORE INSERT ON comment_node
    FOR EACH ROW
    BEGIN
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM post p
          WHERE p.id = NEW.root_post_id AND p.deleted_at IS NOT NULL
        )
        THEN RAISE(ABORT, 'cannot insert into a soft-deleted subtree')
      END;
      SELECT CASE
        WHEN NEW.parent_id IS NOT NULL
          AND EXISTS (
            WITH RECURSIVE ancestors(id, parent_id, deleted_at) AS (
              SELECT id, parent_id, deleted_at FROM comment_node WHERE id = NEW.parent_id
              UNION ALL
              SELECT c.id, c.parent_id, c.deleted_at
              FROM comment_node c
              JOIN ancestors a ON c.id = a.parent_id
            )
            SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL
          )
        THEN RAISE(ABORT, 'cannot insert into a soft-deleted subtree')
      END;
    END;
    `,
    'DROP TRIGGER IF EXISTS seed_actor_membership;',
    `
    ALTER TABLE workspace_member RENAME TO workspace_member_c1a;
    `,
    `
    CREATE TABLE workspace_member (
      workspace_id         TEXT NOT NULL,
      actor_id             TEXT NOT NULL,
      role                 TEXT NOT NULL CHECK (role IN ('read', 'write')),
      status               TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('invited', 'active', 'suspended')),
      invited_by_actor_id  TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
      accepted_at          TEXT,
      PRIMARY KEY (workspace_id, actor_id),
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE CASCADE,
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      FOREIGN KEY (invited_by_actor_id) REFERENCES actor (id) ON DELETE SET NULL
    );
    `,
    `
    INSERT OR IGNORE INTO workspace_member (
      workspace_id, actor_id, role, status, created_at, updated_at, accepted_at
    )
    SELECT workspace_id, actor_id, role, 'active', created_at, created_at, created_at
    FROM workspace_member_c1a;
    `,
    'DROP TABLE workspace_member_c1a;',
    'CREATE INDEX idx_workspace_member_actor ON workspace_member (actor_id, status);',
    'CREATE INDEX idx_workspace_member_workspace_status ON workspace_member (workspace_id, status);',
    `
    CREATE TRIGGER seed_actor_home_membership
    AFTER INSERT ON actor
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO workspace_member (
        workspace_id, actor_id, role, status, accepted_at
      )
      VALUES (NEW.workspace_id, NEW.id, 'write', 'active', datetime('now'));
    END;
    `,
    `
    CREATE TABLE auth_identity (
      id             TEXT PRIMARY KEY NOT NULL,
      actor_id       TEXT NOT NULL UNIQUE,
      email          TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash  TEXT NOT NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      CHECK (length(email) > 0),
      CHECK (length(password_hash) > 0)
    );
    `,
    `
    CREATE TRIGGER enforce_auth_identity_human_actor
    AFTER INSERT ON auth_identity
    FOR EACH ROW
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM actor a WHERE a.id = NEW.actor_id AND a.kind = 'human'
        )
        THEN RAISE(ABORT, 'auth_identity may only reference a human actor')
      END;
    END;
    `,
    `
    CREATE TRIGGER enforce_auth_identity_human_actor_update
    AFTER UPDATE OF actor_id ON auth_identity
    FOR EACH ROW
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM actor a WHERE a.id = NEW.actor_id AND a.kind = 'human'
        )
        THEN RAISE(ABORT, 'auth_identity may only reference a human actor')
      END;
    END;
    `,
    'CREATE INDEX idx_auth_identity_actor ON auth_identity (actor_id);',
    `
    CREATE TABLE auth_session (
      id            TEXT PRIMARY KEY NOT NULL,
      actor_id      TEXT NOT NULL,
      workspace_id  TEXT NOT NULL,
      secret_hash   TEXT NOT NULL UNIQUE,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at    TEXT NOT NULL,
      revoked_at    TEXT,
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, actor_id)
        REFERENCES workspace_member (workspace_id, actor_id) ON DELETE CASCADE,
      CHECK (length(secret_hash) > 0)
    );
    `,
    'CREATE INDEX idx_auth_session_actor ON auth_session (actor_id, revoked_at);',
    'CREATE INDEX idx_auth_session_secret ON auth_session (secret_hash);',
    `
    CREATE TABLE workspace_invite (
      id                    TEXT PRIMARY KEY NOT NULL,
      workspace_id          TEXT NOT NULL,
      email                 TEXT NOT NULL COLLATE NOCASE,
      role                  TEXT NOT NULL CHECK (role IN ('read', 'write')),
      status                TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'accepted', 'revoked')),
      invited_by_actor_id   TEXT,
      token_hash            TEXT,
      accepted_by_actor_id  TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      accepted_at           TEXT,
      revoked_at            TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE CASCADE,
      FOREIGN KEY (invited_by_actor_id) REFERENCES actor (id) ON DELETE SET NULL,
      FOREIGN KEY (accepted_by_actor_id) REFERENCES actor (id) ON DELETE SET NULL,
      CHECK (length(email) > 0)
    );
    `,
    'CREATE INDEX idx_workspace_invite_workspace ON workspace_invite (workspace_id, status);',
    `
    CREATE UNIQUE INDEX idx_workspace_invite_pending_email
    ON workspace_invite (workspace_id, email)
    WHERE status = 'pending';
    `,
    `
    CREATE TABLE workspace_share (
      id                  TEXT PRIMARY KEY NOT NULL,
      workspace_id        TEXT NOT NULL,
      actor_id            TEXT NOT NULL,
      role                TEXT NOT NULL CHECK (role IN ('read', 'write')),
      status              TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'revoked')),
      shared_by_actor_id  TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at          TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE CASCADE,
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      FOREIGN KEY (shared_by_actor_id) REFERENCES actor (id) ON DELETE SET NULL
    );
    `,
    'CREATE INDEX idx_workspace_share_actor ON workspace_share (actor_id, status);',
    `
    CREATE UNIQUE INDEX idx_workspace_share_active_actor
    ON workspace_share (workspace_id, actor_id)
    WHERE status = 'active';
    `,
    'DROP TRIGGER IF EXISTS enforce_agent_credential_kind_update;',
    'DROP TRIGGER IF EXISTS enforce_agent_credential_kind;',
    'DROP INDEX IF EXISTS idx_agent_credential_workspace;',
    'DROP INDEX IF EXISTS idx_agent_credential_actor;',
    'ALTER TABLE agent_credential RENAME TO agent_credential_c7;',
    `
    CREATE TABLE agent_credential (
      id              TEXT PRIMARY KEY NOT NULL,
      actor_id        TEXT NOT NULL,
      workspace_id    TEXT NOT NULL,
      secret_hash     TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'revoked')),
      label           TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at      TEXT,
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
      CHECK (secret_hash IS NOT NULL)
    );
    `,
    `
    INSERT INTO agent_credential (
      id, actor_id, workspace_id, secret_hash, status, label, created_at, revoked_at
    )
    SELECT id, actor_id, workspace_id, secret_hash, status, label, created_at, revoked_at
    FROM agent_credential_c7;
    `,
    'DROP TABLE agent_credential_c7;',
    `
    CREATE TRIGGER enforce_agent_credential_scope
    AFTER INSERT ON agent_credential
    FOR EACH ROW
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM actor a WHERE a.id = NEW.actor_id AND a.kind = 'agent'
        )
        THEN RAISE(ABORT, 'agent_credential may only reference an agent actor')
      END;
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM workspace_member m
          WHERE m.workspace_id = NEW.workspace_id
            AND m.actor_id = NEW.actor_id
            AND m.status = 'active'
        )
        THEN RAISE(ABORT, 'agent_credential actor must be an active member of its workspace')
      END;
    END;
    `,
    `
    CREATE TRIGGER enforce_agent_credential_scope_update
    AFTER UPDATE OF actor_id, workspace_id ON agent_credential
    FOR EACH ROW
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM actor a WHERE a.id = NEW.actor_id AND a.kind = 'agent'
        )
        THEN RAISE(ABORT, 'agent_credential may only reference an agent actor')
      END;
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM workspace_member m
          WHERE m.workspace_id = NEW.workspace_id
            AND m.actor_id = NEW.actor_id
            AND m.status = 'active'
        )
        THEN RAISE(ABORT, 'agent_credential actor must be an active member of its workspace')
      END;
    END;
    `,
    'CREATE INDEX idx_agent_credential_actor ON agent_credential (actor_id);',
    'CREATE INDEX idx_agent_credential_workspace ON agent_credential (workspace_id);',
    'DROP INDEX IF EXISTS idx_agent_audit_workspace;',
    'DROP INDEX IF EXISTS idx_agent_audit_actor;',
    'ALTER TABLE agent_audit_log RENAME TO agent_audit_log_c7;',
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
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT
    );
    `,
    `
    INSERT INTO agent_audit_log (
      id, actor_id, workspace_id, action, target_id, root_post_id, idempotency_key, created_at
    )
    SELECT id, actor_id, workspace_id, action, target_id, root_post_id, idempotency_key, created_at
    FROM agent_audit_log_c7;
    `,
    'DROP TABLE agent_audit_log_c7;',
    'CREATE INDEX idx_agent_audit_actor ON agent_audit_log (actor_id, created_at);',
    'CREATE INDEX idx_agent_audit_workspace ON agent_audit_log (workspace_id, created_at);',
    'DROP INDEX IF EXISTS idx_agent_idempotency_actor;',
    'ALTER TABLE agent_idempotency_key RENAME TO agent_idempotency_key_c7;',
    `
    CREATE TABLE agent_idempotency_key (
      key             TEXT NOT NULL,
      actor_id        TEXT NOT NULL,
      workspace_id    TEXT NOT NULL,
      action          TEXT NOT NULL CHECK (action IN ('create_post','create_comment','create_reply')),
      target_id       TEXT NOT NULL,
      request_digest  TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (key, actor_id, workspace_id, action),
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT
    );
    `,
    `
    INSERT INTO agent_idempotency_key (
      key, actor_id, workspace_id, action, target_id, request_digest, created_at
    )
    SELECT key, actor_id, workspace_id, action, target_id, request_digest, created_at
    FROM agent_idempotency_key_c7;
    `,
    'DROP TABLE agent_idempotency_key_c7;',
    'CREATE INDEX idx_agent_idempotency_actor ON agent_idempotency_key (actor_id, workspace_id, created_at);',
    'DROP INDEX IF EXISTS idx_agent_quota_actor_time;',
    'ALTER TABLE agent_quota_state RENAME TO agent_quota_state_c7;',
    `
    CREATE TABLE agent_quota_state (
      id              INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      actor_id        TEXT NOT NULL,
      workspace_id    TEXT NOT NULL,
      occurred_at     INTEGER NOT NULL,
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT
    );
    `,
    `
    INSERT INTO agent_quota_state (id, actor_id, workspace_id, occurred_at)
    SELECT id, actor_id, workspace_id, occurred_at
    FROM agent_quota_state_c7;
    `,
    'DROP TABLE agent_quota_state_c7;',
    'CREATE INDEX idx_agent_quota_actor_time ON agent_quota_state (actor_id, occurred_at);',
  ],
  down: [
    'DROP INDEX IF EXISTS idx_agent_quota_actor_time;',
    'ALTER TABLE agent_quota_state RENAME TO agent_quota_state_c9;',
    `
    CREATE TABLE agent_quota_state (
      id              INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      actor_id        TEXT NOT NULL,
      workspace_id    TEXT NOT NULL,
      occurred_at     INTEGER NOT NULL,
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
      FOREIGN KEY (workspace_id, actor_id)
        REFERENCES actor (workspace_id, id) ON DELETE CASCADE
    );
    `,
    `
    INSERT INTO agent_quota_state (id, actor_id, workspace_id, occurred_at)
    SELECT q.id, q.actor_id, q.workspace_id, q.occurred_at
    FROM agent_quota_state_c9 q
    JOIN actor a ON a.id = q.actor_id AND a.workspace_id = q.workspace_id;
    `,
    'DROP TABLE agent_quota_state_c9;',
    'CREATE INDEX idx_agent_quota_actor_time ON agent_quota_state (actor_id, occurred_at);',
    'DROP INDEX IF EXISTS idx_agent_idempotency_actor;',
    'ALTER TABLE agent_idempotency_key RENAME TO agent_idempotency_key_c9;',
    `
    CREATE TABLE agent_idempotency_key (
      key             TEXT NOT NULL,
      actor_id        TEXT NOT NULL,
      workspace_id    TEXT NOT NULL,
      action          TEXT NOT NULL CHECK (action IN ('create_post','create_comment','create_reply')),
      target_id       TEXT NOT NULL,
      request_digest  TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (key, actor_id, workspace_id, action),
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
      FOREIGN KEY (workspace_id, actor_id)
        REFERENCES actor (workspace_id, id) ON DELETE CASCADE
    );
    `,
    `
    INSERT INTO agent_idempotency_key (
      key, actor_id, workspace_id, action, target_id, request_digest, created_at
    )
    SELECT i.key, i.actor_id, i.workspace_id, i.action, i.target_id, i.request_digest, i.created_at
    FROM agent_idempotency_key_c9 i
    JOIN actor a ON a.id = i.actor_id AND a.workspace_id = i.workspace_id;
    `,
    'DROP TABLE agent_idempotency_key_c9;',
    'DROP INDEX IF EXISTS idx_agent_audit_workspace;',
    'DROP INDEX IF EXISTS idx_agent_audit_actor;',
    'ALTER TABLE agent_audit_log RENAME TO agent_audit_log_c9;',
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
    `
    INSERT INTO agent_audit_log (
      id, actor_id, workspace_id, action, target_id, root_post_id, idempotency_key, created_at
    )
    SELECT l.id, l.actor_id, l.workspace_id, l.action, l.target_id,
           l.root_post_id, l.idempotency_key, l.created_at
    FROM agent_audit_log_c9 l
    JOIN actor a ON a.id = l.actor_id AND a.workspace_id = l.workspace_id;
    `,
    'DROP TABLE agent_audit_log_c9;',
    'CREATE INDEX idx_agent_audit_actor ON agent_audit_log (actor_id, created_at);',
    'CREATE INDEX idx_agent_audit_workspace ON agent_audit_log (workspace_id, created_at);',
    'DROP TRIGGER IF EXISTS enforce_agent_credential_scope_update;',
    'DROP TRIGGER IF EXISTS enforce_agent_credential_scope;',
    'DROP INDEX IF EXISTS idx_agent_credential_workspace;',
    'DROP INDEX IF EXISTS idx_agent_credential_actor;',
    'ALTER TABLE agent_credential RENAME TO agent_credential_c9;',
    `
    CREATE TABLE agent_credential (
      id              TEXT PRIMARY KEY NOT NULL,
      actor_id        TEXT NOT NULL,
      workspace_id    TEXT NOT NULL,
      secret_hash     TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'revoked')),
      label           TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at      TEXT,
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
      FOREIGN KEY (workspace_id, actor_id)
        REFERENCES actor (workspace_id, id) ON DELETE CASCADE,
      CHECK (secret_hash IS NOT NULL)
    );
    `,
    `
    INSERT INTO agent_credential (
      id, actor_id, workspace_id, secret_hash, status, label, created_at, revoked_at
    )
    SELECT c.id, c.actor_id, c.workspace_id, c.secret_hash, c.status, c.label, c.created_at, c.revoked_at
    FROM agent_credential_c9 c
    JOIN actor a ON a.id = c.actor_id AND a.workspace_id = c.workspace_id;
    `,
    'DROP TABLE agent_credential_c9;',
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
    'DROP INDEX IF EXISTS idx_workspace_share_active_actor;',
    'DROP INDEX IF EXISTS idx_workspace_share_actor;',
    'DROP TABLE IF EXISTS workspace_share;',
    'DROP INDEX IF EXISTS idx_workspace_invite_pending_email;',
    'DROP INDEX IF EXISTS idx_workspace_invite_workspace;',
    'DROP TABLE IF EXISTS workspace_invite;',
    'DROP INDEX IF EXISTS idx_auth_session_secret;',
    'DROP INDEX IF EXISTS idx_auth_session_actor;',
    'DROP TABLE IF EXISTS auth_session;',
    'DROP INDEX IF EXISTS idx_auth_identity_actor;',
    'DROP TRIGGER IF EXISTS enforce_auth_identity_human_actor_update;',
    'DROP TRIGGER IF EXISTS enforce_auth_identity_human_actor;',
    'DROP TABLE IF EXISTS auth_identity;',
    'DROP TRIGGER IF EXISTS seed_actor_home_membership;',
    'DROP INDEX IF EXISTS idx_workspace_member_workspace_status;',
    'DROP INDEX IF EXISTS idx_workspace_member_actor;',
    'ALTER TABLE workspace_member RENAME TO workspace_member_c9;',
    `
    CREATE TABLE workspace_member (
      workspace_id TEXT NOT NULL,
      actor_id     TEXT NOT NULL,
      role         TEXT NOT NULL CHECK (role IN ('read', 'write')),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workspace_id, actor_id),
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE CASCADE,
      FOREIGN KEY (actor_id) REFERENCES actor (id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, actor_id)
        REFERENCES actor (workspace_id, id) ON DELETE CASCADE
    );
    `,
    `
    INSERT OR IGNORE INTO workspace_member (workspace_id, actor_id, role, created_at)
    SELECT m.workspace_id, m.actor_id, m.role, m.created_at
    FROM workspace_member_c9 m
    JOIN actor a ON a.id = m.actor_id AND a.workspace_id = m.workspace_id
    WHERE m.status = 'active';
    `,
    'DROP TABLE workspace_member_c9;',
    `
    CREATE TRIGGER seed_actor_membership
    AFTER INSERT ON actor
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO workspace_member (workspace_id, actor_id, role)
      VALUES (NEW.workspace_id, NEW.id, 'write');
    END;
    `,
    'DROP TRIGGER IF EXISTS enforce_no_insert_into_deleted_subtree;',
    'DROP TRIGGER IF EXISTS enforce_comment_workspace_consistency;',
    'DROP INDEX IF EXISTS idx_comment_workspace;',
    'DROP INDEX IF EXISTS idx_comment_parent;',
    'DROP INDEX IF EXISTS idx_comment_root;',
    'DROP INDEX IF EXISTS idx_post_feed;',
    'ALTER TABLE comment_node RENAME TO comment_node_c9_membership_scope;',
    'ALTER TABLE post RENAME TO post_c9_membership_scope;',
    `
    CREATE TABLE post (
      id               TEXT PRIMARY KEY NOT NULL,
      workspace_id     TEXT NOT NULL,
      author_actor_id  TEXT NOT NULL,
      content          TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity_at TEXT NOT NULL,
      deleted_at       TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
      FOREIGN KEY (author_actor_id) REFERENCES actor (id) ON DELETE RESTRICT,
      FOREIGN KEY (workspace_id, author_actor_id)
        REFERENCES actor (workspace_id, id) ON DELETE RESTRICT,
      CHECK (last_activity_at IS NOT NULL)
    );
    `,
    'CREATE INDEX idx_post_feed ON post (workspace_id, last_activity_at DESC, id DESC);',
    `
    INSERT INTO post (id, workspace_id, author_actor_id, content, created_at, last_activity_at, deleted_at)
    SELECT p.id, p.workspace_id, p.author_actor_id, p.content, p.created_at, p.last_activity_at, p.deleted_at
    FROM post_c9_membership_scope p
    JOIN actor a ON a.id = p.author_actor_id AND a.workspace_id = p.workspace_id;
    `,
    `
    CREATE TABLE comment_node (
      id              TEXT PRIMARY KEY NOT NULL,
      workspace_id    TEXT NOT NULL,
      root_post_id    TEXT NOT NULL,
      parent_id       TEXT,
      author_actor_id TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at      TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
      FOREIGN KEY (root_post_id) REFERENCES post (id) ON DELETE RESTRICT,
      FOREIGN KEY (parent_id) REFERENCES comment_node (id) ON DELETE RESTRICT,
      FOREIGN KEY (author_actor_id) REFERENCES actor (id) ON DELETE RESTRICT,
      FOREIGN KEY (workspace_id, author_actor_id)
        REFERENCES actor (workspace_id, id) ON DELETE RESTRICT,
      CHECK (workspace_id IS NOT NULL AND root_post_id IS NOT NULL),
      CHECK (parent_id IS NULL OR parent_id <> id)
    );
    `,
    'CREATE INDEX idx_comment_root ON comment_node (root_post_id, created_at, id);',
    'CREATE INDEX idx_comment_parent ON comment_node (parent_id, created_at, id);',
    'CREATE INDEX idx_comment_workspace ON comment_node (workspace_id);',
    `
    WITH RECURSIVE eligible(id) AS (
      SELECT c.id
      FROM comment_node_c9_membership_scope c
      JOIN actor a ON a.id = c.author_actor_id AND a.workspace_id = c.workspace_id
      JOIN post p ON p.id = c.root_post_id
      WHERE c.parent_id IS NULL
      UNION ALL
      SELECT child.id
      FROM comment_node_c9_membership_scope child
      JOIN eligible parent ON parent.id = child.parent_id
      JOIN actor a ON a.id = child.author_actor_id AND a.workspace_id = child.workspace_id
      JOIN post p ON p.id = child.root_post_id
    )
    INSERT INTO comment_node (
      id, workspace_id, root_post_id, parent_id, author_actor_id, content, created_at, deleted_at
    )
    SELECT c.id, c.workspace_id, c.root_post_id, c.parent_id, c.author_actor_id, c.content, c.created_at, c.deleted_at
    FROM comment_node_c9_membership_scope c
    JOIN eligible e ON e.id = c.id;
    `,
    'DROP TABLE comment_node_c9_membership_scope;',
    'DROP TABLE post_c9_membership_scope;',
    `
    CREATE TRIGGER enforce_comment_workspace_consistency
    BEFORE INSERT ON comment_node
    FOR EACH ROW
    BEGIN
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM post p WHERE p.id = NEW.root_post_id)
          AND NOT EXISTS (
            SELECT 1 FROM post p
            WHERE p.id = NEW.root_post_id AND p.workspace_id = NEW.workspace_id
          )
        THEN RAISE(ABORT, 'comment_node workspace_id must match its root post workspace')
      END;
      SELECT CASE
        WHEN NEW.parent_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM comment_node c WHERE c.id = NEW.parent_id)
          AND NOT EXISTS (
            SELECT 1 FROM comment_node c
            WHERE c.id = NEW.parent_id
              AND c.workspace_id = NEW.workspace_id
              AND c.root_post_id = NEW.root_post_id
          )
        THEN RAISE(ABORT, 'reply parent must share workspace and root post')
      END;
    END;
    `,
    `
    CREATE TRIGGER enforce_no_insert_into_deleted_subtree
    BEFORE INSERT ON comment_node
    FOR EACH ROW
    BEGIN
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM post p
          WHERE p.id = NEW.root_post_id AND p.deleted_at IS NOT NULL
        )
        THEN RAISE(ABORT, 'cannot insert into a soft-deleted subtree')
      END;
      SELECT CASE
        WHEN NEW.parent_id IS NOT NULL
          AND EXISTS (
            WITH RECURSIVE ancestors(id, parent_id, deleted_at) AS (
              SELECT id, parent_id, deleted_at FROM comment_node WHERE id = NEW.parent_id
              UNION ALL
              SELECT c.id, c.parent_id, c.deleted_at
              FROM comment_node c
              JOIN ancestors a ON c.id = a.parent_id
            )
            SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL
          )
        THEN RAISE(ABORT, 'cannot insert into a soft-deleted subtree')
      END;
    END;
    `,
  ],
};
