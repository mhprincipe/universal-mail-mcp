// Run from a normal user terminal. This never loads .env or Yahoo credentials.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const project = fileURLToPath(new URL('../', import.meta.url));
const reportPath = fileURLToPath(new URL('../../docker-verification.json', import.meta.url));
const candidates = [
  process.env.DOCKER_CLI,
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'),
  'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
].filter(Boolean);
const docker = candidates.find(path => existsSync(path)) ?? 'docker';
const report = { startedAt: new Date().toISOString(), passed: false, checks: [], mailboxConnected: false };
const containers = [];
function saveReport() {
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
}
saveReport();
console.log('Docker verification started. No Yahoo credentials will be loaded.');
console.log(`Progress report: ${reportPath}`);
function run(args, inherit = false) {
  report.currentStep = `docker ${args[0]}`;
  report.updatedAt = new Date().toISOString();
  saveReport();
  console.log(`Checking: ${report.currentStep}`);
  const timeout = args[0] === 'build' ? 20 * 60 * 1000 : 30000;
  return execFileSync(docker, args, { cwd: project, encoding: 'utf8', stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], timeout, windowsHide: true });
}
function passed(check) { report.checks.push(check); saveReport(); console.log(`PASS: ${check}`); }
function http(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers, timeout: 5000 }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('HTTP check timed out')));
    req.end();
  });
}
async function start(env = []) {
  const args = ['run', '--detach', '--rm', '--publish', '127.0.0.1::8080', '--memory', '512m', '--cpus', '1'];
  for (const value of env) args.push('--env', value);
  args.push('yahoo-mail-mcp:local');
  const id = run(args).trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker did not return a valid container ID');
  containers.push(id);
  const binding = run(['port', id, '8080/tcp']).trim();
  if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error('Expected a loopback-only published port');
  const base = `http://${binding}`;
  for (let i = 0; i < 60; i++) {
    try { if ((await http(base + '/health')).status === 200) return { id, base }; } catch { /* starting */ }
    await setTimeout(500);
  }
  throw new Error('Container health did not become available');
}
try {
  report.dockerVersion = JSON.parse(run(['version', '--format', '{{json .}}'])).Server.Version;
  run(['build', '--progress=plain', '--tag', 'yahoo-mail-mcp:local', '.'], true);
  passed('Docker image build');
  const bare = await start();
  const health = await http(bare.base + '/health');
  assert.deepEqual(JSON.parse(health.text), { status: 'ok', service: 'yahoo-mail-mcp', version: '0.1.0' });
  passed('Container health works without mail secrets');
  assert.equal(run(['exec', bare.id, 'id', '-u']).trim(), '1000');
  passed('Container runs as non-root user');

  const token = 'docker-verification-dummy-token-123456';
  const test = await start([
    'YAHOO_EMAIL=dummy@example.invalid', 'YAHOO_APP_PASSWORD=dummy-password',
    `MCP_ACCESS_SECRET=${token}`, 'IMAP_HOST=127.0.0.1', 'IMAP_PORT=1',
    'SMTP_HOST=127.0.0.1', 'SMTP_PORT=1', 'SENT_COPY_MODE=unverified',
    'ALLOWED_HOSTS=localhost,127.0.0.1', 'ALLOWED_ORIGINS='
  ]);
  const auth = { Authorization: `Bearer ${token}` };
  for (const path of ['/mcp', '/ready']) {
    assert.equal((await http(test.base + path)).status, 401);
    assert.equal((await http(test.base + path, { Authorization: 'Bearer incorrect' })).status, 401);
  }
  passed('MCP and readiness reject missing and wrong bearer tokens');
  for (const headers of [{ Host: 'attacker.invalid' }, { Origin: 'https://attacker.invalid' }]) {
    assert.equal((await http(test.base + '/mcp', { ...auth, ...headers })).status, 403);
  }
  passed('Protected endpoint Host and Origin validation');
  assert.equal((await http(test.base + '/ready', auth)).status, 503);
  passed('Readiness fails safely with loopback-only dummy mail endpoints');

  const client = new Client({ name: 'docker-local-verification', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(test.base + '/mcp'), { requestInit: { headers: auth } }));
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    const expected = ['search_email','get_email','get_thread','create_draft','update_draft','send_email','reply_email','move_email','archive_email','mark_read','mark_unread','flag_email','trash_email','restore_email','list_folders','create_folder'].sort();
    assert.deepEqual(names, expected);
    report.tools = names;
    passed('Exactly 16 required MCP tools discovered in the container');
    const result = await client.callTool({ name: 'send_email', arguments: { to: ['dummy@example.invalid'], subject: 'Local verification', text: 'Dummy content' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.code, 'SENT_POLICY_UNVERIFIED');
    passed('Unverified Sent policy blocks sending before SMTP');
  } finally { await client.close(); }
  report.imageId = run(['image', 'inspect', '--format', '{{.Id}}', 'yahoo-mail-mcp:local']).trim();
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error('Verification failed:', report.error);
  process.exitCode = 1;
} finally {
  for (const id of containers) {
    try { run(['rm', '--force', id]); }
    catch { report.passed = false; report.cleanupError = 'A test container could not be removed'; process.exitCode = 1; }
  }
  report.currentStep = report.passed ? 'complete' : 'failed';
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Verification report saved to ${reportPath}`);
}
