import type { MessageCode } from './messages.js';

// Setup stops with a registry message: its code, and the values it shows.
export class Stop extends Error {
  constructor(readonly code: MessageCode, readonly values: Record<string, string> = {}) { super(code); }
}
