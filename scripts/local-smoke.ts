import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
const env = { ...process.env, NODE_ENV: 'test', PORT: '18080', YAHOO_EMAIL: 'dummy@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password', MCP_ACCESS_SECRET: 'local-dummy-token-at-least-24-chars', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1', IMAP_PORT: '1', SMTP_PORT: '1', ALLOWED_HOSTS: 'localhost,127.0.0.1', ALLOWED_ORIGINS: '', SENT_COPY_MODE: 'unverified' };
const child = spawn(process.execPath, ['dist/src/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', chunk => process.stdout.write(chunk));
child.stderr.on('data', chunk => process.stderr.write(chunk));
const exited = once(child, 'exit');
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Server exited before startup');
    try { ready = (await fetch('http://127.0.0.1:18080/health')).ok; } catch { /* starting */ }
    if (ready) break;
    await setTimeout(50);
  }
  if (!ready) throw new Error('Local server startup timed out');
  process.env.MCP_URL = 'http://127.0.0.1:18080/mcp';
  process.env.MCP_ACCESS_SECRET = env.MCP_ACCESS_SECRET;
  await import('./mcp-smoke.js');
} finally {
  child.kill();
  await exited;
}
