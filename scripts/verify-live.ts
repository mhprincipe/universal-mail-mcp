import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { callReadTool, expectedTools, probeStatus, safeFailure } from './verification-client.js';

// No .env loading. A live endpoint, secret, and fixture manifest must be explicit.
if (process.env.LIVE_READ_CONFIRMED !== 'yes') throw new Error('Set LIVE_READ_CONFIRMED=yes for explicit read-only live verification.');
const base = new URL(process.env.SERVICE_URL ?? '');
if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('SERVICE_URL must be a plain HTTPS service origin.');
const token = process.env.MCP_ACCESS_SECRET;
if (!token || token.length < 24) throw new Error('MCP_ACCESS_SECRET missing.');
const fixturePath = process.env.MCP_TEST_FIXTURE;
if (!fixturePath) throw new Error('MCP_TEST_FIXTURE must identify an approved test conversation.');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
assert.equal(typeof fixture.subject, 'string');
assert.equal(typeof fixture.seedMessageId, 'string');
assert.equal(typeof fixture.replyMessageId, 'string');
assert.equal(fixture.mailbox, 'INBOX');
const auth = { Authorization: `Bearer ${token}` };
const report: Record<string, any> = { startedAt: new Date().toISOString(), passed: false, mode: 'live-read-only', sends: 0, mutations: 0, checks: [] };
let stage = 'configuration';
let client: Client | undefined;
const pass = (name: string) => { report.checks.push(name); console.log(`PASS: ${name}`); };
const request = (path: string, headers: Record<string, string> = {}) => fetch(new URL(path, base), { headers, redirect: 'error', signal: AbortSignal.timeout(90000) });
const findSeed = async () => {
  stage = 'test-message identity';
  const result = await callReadTool(client!, 'search_email', { mailbox: fixture.mailbox, subject: fixture.subject, limit: 100 });
  const matches = result.data.filter((x: any) => x.messageId === fixture.seedMessageId && x.subject === fixture.subject);
  assert.equal(matches.length, 1);
  return matches[0];
};
mkdirSync('verification', { recursive: true });
try {
  const config = JSON.parse(readFileSync(process.env.CLOUD_SERVICE_CONFIG ?? 'cloud-service-check.json', 'utf8'));
  const spec = config.spec.template.spec;
  const env = Object.fromEntries(spec.containers[0].env.map((x: any) => [x.name, x.value]));
  assert.equal(env.SENT_COPY_MODE, 'unverified');
  assert(Number(spec.timeoutSeconds) >= 300);
  assert(env.ALLOWED_HOSTS.split(',').map((x: string) => x.trim()).includes(base.hostname));
  pass('Sending disabled; 300-second timeout; hostname configured');
  stage = 'health';
  const health = await request('/health'); assert.equal(health.status, 200); assert.equal((await health.json()).status, 'ok'); pass(stage);
  for (const path of ['/ready', '/mcp']) for (const [label, headers] of [['missing', {}], ['wrong', { Authorization: 'Bearer invalid-test' }]] as const) {
    stage = `${label} token at ${path}`;
    assert.equal(await probeStatus(new URL(path, base).href, headers), 401); pass(stage);
  }
  stage = 'Origin protection';
  assert.equal(await probeStatus(new URL('/mcp', base).href, { ...auth, Origin: 'https://untrusted.example' }), 403); pass(stage);
  stage = 'Host rejection';
  report.hostStatus = await probeStatus(new URL('/mcp', base).href, { ...auth, Host: 'untrusted.invalid' });
  assert([400, 403, 404, 421].includes(report.hostStatus)); pass('Host rejected by cloud edge or app (not proof of which layer)');
  stage = 'Yahoo connectivity';
  const ready = await request('/ready', auth); assert.equal(ready.status, 200);
  const state = await ready.json(); assert(state.status === 'ready' && state.imap && state.smtp); pass(stage);
  stage = 'MCP discovery';
  client = new Client({ name: 'typed-live-verifier', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: auth } }));
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), expectedTools); pass('Exactly 16 tools');
  const before = await findSeed();
  stage = 'get_email';
  const detail = (await callReadTool(client, 'get_email', { mailbox: fixture.mailbox, uid: before.uid })).data;
  assert.equal(detail.messageId, fixture.seedMessageId); pass('Test email identity verified; content not logged');
  stage = 'get_thread';
  const started = Date.now();
  const heartbeat = setInterval(() => console.log(`Thread check: ${Math.round((Date.now() - started) / 1000)} seconds`), 20000);
  let thread;
  try { thread = await callReadTool(client, 'get_thread', { mailbox: fixture.mailbox, uid: before.uid }); }
  finally { clearInterval(heartbeat); report.threadSeconds = Math.round((Date.now() - started) / 1000); }
  assert.deepEqual(thread.data.map((x: any) => x.messageId).sort(), [fixture.seedMessageId, fixture.replyMessageId].sort());
  assert(!(thread.warnings ?? []).some((x: string) => /could not|fetch limit/i.test(x)));
  pass('Two-message test thread within request deadline');
  const after = await findSeed(); stage = 'flag preservation';
  assert.equal(after.read, before.read); assert.equal(after.flagged, before.flagged); pass(stage);
  report.boundedHistoryWarning = 'Fallback scans only 200 recent messages per folder; older unindexed matches may be omitted.';
  report.passed = true;
} catch (error) {
  report.failedStage = stage; report.failure = safeFailure(error); process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  const body = JSON.stringify(report, null, 2) + '\n';
  writeFileSync(`verification/live-${report.startedAt.replace(/[:.]/g, '-')}.json`, body);
  writeFileSync('verification/live-latest.json', body);
  console.log(body);
}
