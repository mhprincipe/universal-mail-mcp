import { describe, expect, it } from 'vitest';
import { composeRaw } from '../src/mail/mime.js';

// ENG-19 (added: seen in the owner's live test, 2026-09-28). Drafts carried
// a Message-ID ending @yahoo-mail-mcp.local, and every sent email a header
// X-Yahoo-MCP-Operation-ID: version 1's name, visible to anyone who looks at
// the headers. The Message-ID now uses the sender's own domain, as mail apps
// do, and the header names Universal Mail.
describe('what a message says about its sender', () => {
  it('ENG-19 the Message-ID uses the sender\'s domain; the operation header names Universal Mail; nothing says Yahoo MCP (added: found live)', async () => {
    const built = await composeRaw({ from: 'me@example.org', to: ['you@example.net'], subject: 's', text: 't' });
    expect(built.messageId).toMatch(/^<[0-9a-f-]{36}@example\.org>$/);
    const raw = built.raw.toString('utf8');
    expect(raw).toContain(`X-Universal-Mail-Operation-ID: ${built.operationId}`);
    expect(raw.toLowerCase()).not.toContain('yahoo-mail-mcp');
    expect(raw.toLowerCase()).not.toContain('yahoo-mcp');
  });

  it('ENG-19 a sender without a usable domain still gets a well-formed Message-ID; a given one is kept', async () => {
    expect((await composeRaw({ from: 'nobody', to: ['you@example.net'], subject: 's', text: 't' })).messageId).toMatch(/^<[0-9a-f-]{36}@universal-mail\.invalid>$/);
    expect((await composeRaw({ from: 'Me <me@Example.ORG>', to: ['you@example.net'], subject: 's', text: 't' })).messageId).toMatch(/@example\.org>$/);
    expect((await composeRaw({ from: 'me@example.org', to: ['you@example.net'], subject: 's', text: 't', messageId: '<given@x.invalid>' })).messageId).toBe('<given@x.invalid>');
  });
});
