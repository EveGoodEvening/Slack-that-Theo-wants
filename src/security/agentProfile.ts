import type { BetterSqliteDatabase } from '../db/connection.js';

/**
 * C7 agent profile / metadata store.
 *
 * C7 does NOT redefine the C1 actor schema. Agent identity reuses the existing
 * `actor` table with `kind = 'agent'`. This module owns only the agent-
 * specific profile/metadata fields (description, status, capabilities) keyed
 * 1:1 by the actor id. The `enforce_agent_profile_kind` trigger in migration
 * 0003 guarantees a profile row can only reference an agent actor.
 */

/** Agent status used for the machine-readable status metadata contract. */
export type AgentStatus = 'active' | 'suspended' | 'revoked';

/** A stored agent profile row. */
export interface AgentProfileRow {
  actorId: string;
  description: string | null;
  status: AgentStatus;
  capabilities: string;
  createdAt: string;
  updatedAt: string;
}

export class AgentProfileRepository {
  constructor(private readonly db: BetterSqliteDatabase) {}

  /** Create a profile for an agent actor. Throws if the actor is not an agent. */
  create(input: {
    actorId: string;
    description?: string;
    capabilities?: string;
  }): AgentProfileRow {
    this.db
      .prepare(
        'INSERT INTO agent_profile (actor_id, description, status, capabilities) VALUES (?, ?, \'active\', ?)',
      )
      .run(input.actorId, input.description ?? null, input.capabilities ?? '');
    return this.get(input.actorId) as AgentProfileRow;
  }

  /** Get a profile, or undefined if none exists. */
  get(actorId: string): AgentProfileRow | undefined {
    return this.db
      .prepare(
        'SELECT actor_id AS actorId, description, status, capabilities, created_at AS createdAt, updated_at AS updatedAt FROM agent_profile WHERE actor_id = ?',
      )
      .get(actorId) as AgentProfileRow | undefined;
  }

  /** Update profile metadata (description / capabilities). Returns the row or undefined. */
  update(
    actorId: string,
    patch: { description?: string; capabilities?: string },
  ): AgentProfileRow | undefined {
    const current = this.get(actorId);
    if (current === undefined) return undefined;
    this.db
      .prepare(
        'UPDATE agent_profile SET description = ?, capabilities = ?, updated_at = ? WHERE actor_id = ?',
      )
      .run(
        patch.description ?? current.description,
        patch.capabilities ?? current.capabilities,
        new Date().toISOString(),
        actorId,
      );
    return this.get(actorId);
  }

  /** Set the agent status (active / suspended / revoked). Returns the row or undefined. */
  setStatus(actorId: string, status: AgentStatus): AgentProfileRow | undefined {
    this.db
      .prepare('UPDATE agent_profile SET status = ?, updated_at = ? WHERE actor_id = ?')
      .run(status, new Date().toISOString(), actorId);
    return this.get(actorId);
  }
}
