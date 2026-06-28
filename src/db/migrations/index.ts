import type { Migration } from '../migrator.js';
import { migration0001Init } from './0001-init.js';
import { migration0002Membership } from './0002-membership.js';
import { migration0003AgentControlPlane } from './0003-agent-control-plane.js';
import { migration0004AuthCollaboration } from './0004-auth-collaboration.js';

/**
 * All registered migrations in version order. Append new migrations here; never
 * edit an already-applied migration's up/down in place.
 */
export const migrations: readonly Migration[] = [
  migration0001Init,
  migration0002Membership,
  migration0003AgentControlPlane,
  migration0004AuthCollaboration,
];
