import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { failure, MailError } from '../src/errors.js';
import { TOOL_CODES } from '../src/toolCodes.js';
import { startToolFixture } from '../testkit/src/toolFixture.js';

// Phase 5, everyday polish (unit tier): what the AI gets back, and what it's told.
let f: Awaited<ReturnType<typeof startToolFixture>> | undefined;
afterEach(async () => { await f?.stop(); f = undefined; });

describe('everyday polish', () => {
  it('POL-01 format defaults to text: the html is left out', async () => {
    f = await startToolFixture();
    const { uid } = await f.seed('INBOX', { text: 'Hello in plain text', html: '<p>Hello in <b>html</b></p>' });
    const email = (await f.call('get_email', { mailbox: 'INBOX', uid })).result.data;
    expect(email.text).toContain('Hello in plain text');
    expect(email).not.toHaveProperty('html');
    const thread = (await f.call('get_thread', { mailbox: 'INBOX', uid })).result.data;
    expect(thread.every((m: object) => !('html' in m))).toBe(true);
  });

  it('POL-02 format: full includes the html', async () => {
    f = await startToolFixture();
    const { uid } = await f.seed('INBOX', { text: 'Plain', html: '<p>Rich</p>' });
    expect((await f.call('get_email', { mailbox: 'INBOX', uid, format: 'full' })).result.data.html).toContain('<p>Rich</p>');
    expect((await f.call('get_thread', { mailbox: 'INBOX', uid, format: 'full' })).result.data[0].html).toContain('<p>Rich</p>');
  });

  it('POL-03 a body over 100,000 characters is clipped and marked', async () => {
    f = await startToolFixture();
    const { uid } = await f.seed('INBOX', { text: 'x'.repeat(150_000) });
    const answer = (await f.call('get_email', { mailbox: 'INBOX', uid })).result;
    expect(answer.data.text).toHaveLength(100_000);
    expect(answer.data.truncated).toBe(true);
    expect(answer.message).toContain('truncated');
  });

  it('POL-04 a response over 200,000 characters is cut, with an "N more" marker', async () => {
    f = await startToolFixture();
    // Five 80,000-character messages in one thread: 400,000 characters of body.
    const root = await f.seed('INBOX', { subject: 'Long thread', text: 'a'.repeat(80_000), messageId: '<root@fixture.invalid>' });
    for (let i = 0; i < 4; i++) await f.seed('INBOX', { subject: 'Re: Long thread', text: 'b'.repeat(80_000), references: '<root@fixture.invalid>' });
    const answer = await f.call('get_thread', { mailbox: 'INBOX', uid: root.uid });
    expect(answer.size).toBeLessThanOrEqual(200_000);
    expect(answer.result.ok).toBe(true);
    const kept = answer.result.data.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(5);
    expect(answer.result.more).toEqual({ count: 5 - kept, hint: expect.stringContaining('get_email') });
    expect(answer.result.warnings.join(' ')).toContain(`${5 - kept} more`);
  });

  it('POL-04 one email in full format over 200,000 characters: the html is cut to fit, and marked', async () => {
    f = await startToolFixture();
    const { uid } = await f.seed('INBOX', { text: 't'.repeat(100_000), html: `<p>${'h'.repeat(99_990)}</p>` });
    const answer = await f.call('get_email', { mailbox: 'INBOX', uid, format: 'full' });
    expect(answer.size).toBeLessThanOrEqual(200_000);
    expect(answer.result.data.text).toHaveLength(100_000);
    expect(answer.result.data.html.length).toBeLessThan(100_000);
    expect(answer.result.data.truncated).toBe(true);
    expect(answer.result.warnings.join(' ')).toContain('html was shortened');
  });

  it('POL-07 every tool error code has a remedy, and every failure carries it', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
    const used = new Set<string>();
    for (const file of files(src)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/new MailError\(\s*'([A-Z0-9_-]+)'/g)) used.add(m[1]!);
    }
    // Codes classify() produces for errors that aren't MailErrors.
    for (const code of ['AUTH_FAILED', 'TRANSIENT_NETWORK', 'MAIL_OPERATION_FAILED', 'OPERATION_STATUS_UNKNOWN']) used.add(code);
    expect(used.size).toBeGreaterThan(15);
    for (const code of used) {
      expect(TOOL_CODES, code).toHaveProperty(code);
      expect(TOOL_CODES[code as keyof typeof TOOL_CODES].remedy, code).toMatch(/^[A-Z].{10,}\.$/);
    }
    // No remedy for a code nothing uses.
    for (const code of Object.keys(TOOL_CODES)) expect(used, code).toContain(code);
    expect(failure(new MailError('FOLDER_NOT_FOUND', 'Folder Typo was not found.'))).toMatchObject({ code: 'FOLDER_NOT_FOUND', remedy: TOOL_CODES.FOLDER_NOT_FOUND.remedy });
    expect(failure(new Error('something odd'))).toMatchObject({ code: 'MAIL_OPERATION_FAILED', remedy: TOOL_CODES.MAIL_OPERATION_FAILED.remedy });
  });

  it('POL-08 tool descriptions carry the steering text, and name no one provider', async () => {
    f = await startToolFixture();
    const tools = await f.tools();
    const text = (name: string) => { const t = tools.find(x => x.name === name)!; return `${t.title} ${t.description}`; };
    for (const t of tools) expect(`${t.title} ${t.description}`, t.name).not.toMatch(/yahoo/i);
    // Batches: one call for many messages.
    for (const name of ['move_email', 'archive_email', 'trash_email', 'restore_email', 'mark_read', 'mark_unread', 'flag_email']) {
      expect(text(name), name).toContain('uids');
    }
    // UIDs change on a move: re-find by messageId.
    for (const name of ['search_email', 'move_email', 'archive_email', 'trash_email', 'restore_email']) expect(text(name), name).toContain('messageId');
    // Sending: ask which account first, when there is more than one.
    for (const name of ['send_email', 'reply_email']) expect(text(name), name).toMatch(/ask which account/i);
    // Reading: untrusted content.
    for (const name of ['search_email', 'get_email', 'get_thread']) expect(text(name), name).toMatch(/untrusted/i);
    // Formats and paging are discoverable.
    expect(text('get_email')).toContain('format');
    expect(text('search_email')).toContain('cursor');
  });
});
