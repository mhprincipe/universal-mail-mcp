import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = process.env.MCP_URL ?? 'http://127.0.0.1:8080/mcp';
const token = process.env.MCP_ACCESS_SECRET;
if (!token) throw new Error('MCP_ACCESS_SECRET is required');

const expected = [
  'search_email','get_email','get_thread','create_draft','update_draft','send_email','reply_email',
  'move_email','archive_email','mark_read','mark_unread','flag_email','trash_email','restore_email',
  'list_folders','create_folder'
].sort();

const client = new Client(
  { name: 'yahoo-mail-mcp-smoke', version: '0.1.0' },
  { versionNegotiation: { mode: 'auto' } }
);
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } }
});

try {
  await client.connect(transport);
  const result = await client.listTools();
  const actual = result.tools.map(t => t.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Tool mismatch. Expected ${expected.join(', ')}; got ${actual.join(', ')}`);
  }
  console.log(JSON.stringify({ ok: true, protocolEra: client.getProtocolEra(), tools: actual }, null, 2));
} finally {
  await client.close().catch(() => undefined);
}
