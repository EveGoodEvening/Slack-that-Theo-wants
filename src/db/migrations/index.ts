import type { Migration } from '../migrator.js';
import { migration0001Init } from './0001-init.js';

/**
 * All registered migrations in version order. Append new migrations here; never
 * edit an already-applied migration's up/down in place.
 */
export const migrations: readonly Migration[] = [migration0001Init];
