import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MailError } from '../src/errors.js';
import type { MailAccess } from '../src/multiMail.js';
import { buildMcpServer } from '../src/tools.js';

// Which permission each 2.4.1 tool needs, and how it's marked for the apps:
// asked of the account router, which refuses what the owner didn't grant.
const asked: string[] = [];
const mail: MailAccess = {
  names: ['me'],
  service(_account, action) { asked.push(action); throw new MailError('MAIL-NOT-PERMITTED', 'not in this test'); },
  search: async () => { throw new Error('not used'); }
};
let client: Client | undefined;
afterEach(async () => { await client?.close(); client = undefined; asked.length = 0; });

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(mail).connect(serverSide);
  client = new Client({ name: 'permissions', version: '1' });
  await client.connect(clientSide);
  return client;
}

describe('the permission each new tool asks for', () => {
  it('FWD-05 forward_email needs Send, and is marked as reaching outside', async () => {
    const c = await connect();
    const tool = (await c.listTools()).tools.find(t => t.name === 'forward_email')!;
    expect(tool.annotations).toMatchObject({ openWorldHint: true });
    expect(tool.annotations?.readOnlyHint).not.toBe(true);
    await c.callTool({ name: 'forward_email', arguments: { mailbox: 'INBOX', uid: 1, to: ['a@example.invalid'] } });
    expect(asked).toEqual(['send']);
  });

  it('UNS-08 unsubscribe needs Organize, and is marked as reaching outside; never read-only', async () => {
    const c = await connect();
    const tool = (await c.listTools()).tools.find(t => t.name === 'unsubscribe')!;
    expect(tool.annotations).toMatchObject({ openWorldHint: true });
    expect(tool.annotations?.readOnlyHint).not.toBe(true);
    await c.callTool({ name: 'unsubscribe', arguments: { mailbox: 'INBOX', uid: 1 } });
    expect(asked).toEqual(['organize']);
  });

  it('JNK-03 junk_email needs Organize, takes one message or a batch, and is not read-only', async () => {
    const c = await connect();
    const tool = (await c.listTools()).tools.find(t => t.name === 'junk_email')!;
    expect(tool.annotations?.readOnlyHint).not.toBe(true);
    expect(Object.keys((tool.inputSchema as any).properties)).toEqual(expect.arrayContaining(['mailbox', 'uid', 'uids']));
    await c.callTool({ name: 'junk_email', arguments: { mailbox: 'INBOX', uids: [1, 2] } });
    expect(asked).toEqual(['organize']);
  });

  it('WHO-04 summarize_senders needs only Read, and is marked read-only so apps run it without asking', async () => {
    const c = await connect();
    const tool = (await c.listTools()).tools.find(t => t.name === 'summarize_senders')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    await c.callTool({ name: 'summarize_senders', arguments: {} });
    expect(asked).toEqual(['read']);
  });
});
