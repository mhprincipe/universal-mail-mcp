import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { TOOL_NAMES } from '../src/tools.js';

const expected = [
  'search_email','get_email','get_attachment','get_thread','create_draft','update_draft','send_email','reply_email',
  'forward_email','summarize_senders','unsubscribe',
  'move_email','archive_email','mark_read','mark_unread','flag_email','trash_email','junk_email','restore_email',
  'list_folders','create_folder'
];

describe('MCP tool contract', () => {
  it('keeps exactly the requested v1 tool names', async () => {
    const source = await readFile(new URL('../src/tools.ts', import.meta.url), 'utf8');
    const found = [...source.matchAll(/registerTool\('([^']+)'/g)].map(m => m[1]);
    expect(found).toEqual(expected);
    // The list the server keeps, to tell the owner about new tools (NTC-01).
    expect([...TOOL_NAMES]).toEqual(found);
  });
});
