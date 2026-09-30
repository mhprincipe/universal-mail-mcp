import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

const expected = [
  'search_email','get_email','get_attachment','get_thread','create_draft','update_draft','send_email','reply_email',
  'move_email','archive_email','mark_read','mark_unread','flag_email','trash_email','restore_email',
  'list_folders','create_folder'
];

describe('MCP tool contract', () => {
  it('keeps exactly the requested v1 tool names', async () => {
    const source = await readFile(new URL('../src/tools.ts', import.meta.url), 'utf8');
    const found = [...source.matchAll(/registerTool\('([^']+)'/g)].map(m => m[1]);
    expect(found).toEqual(expected);
  });
});
