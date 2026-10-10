import { EventEmitter } from 'node:events';
// Local wake-up hint only. SQLite remains authoritative across process restarts.
export const taskChanges = new EventEmitter();
