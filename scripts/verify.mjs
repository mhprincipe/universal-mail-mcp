import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this entry point with npm run verify.');
const extras = process.argv.slice(2);
if (extras.some(arg => arg !== '--docker')) throw new Error('Only --docker is supported. Live checks use verify:live.');
const report = { startedAt: new Date().toISOString(), passed: false, mode: 'local-fixtures', realMailboxAccess: false, stages: [] };
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(YAHOO_|MCP_|IMAP_|SMTP_|OAUTH_|AUTH_MODE$|SENT_COPY_MODE|NODE_OPTIONS$)/i.test(key)) delete env[key];
const stages = [
  ['typecheck', [npm, 'run', 'typecheck']],
  ['unit, fault, HTTP and all-16-tool fixture workflow', [npm, 'test']],
  ['production build', [npm, 'run', 'build']],
  ['compiled server and MCP discovery', ['dist/scripts/local-smoke.js']]
];
if (extras.includes('--docker')) stages.push(['Docker verification', ['scripts/docker-verify.mjs']]);
mkdirSync(join(root, 'verification'), { recursive: true });
const stamp = report.startedAt.replace(/[:.]/g, '-');
try {
  for (const [name, args] of stages) {
    console.log(`\nVERIFY: ${name}`);
    const start = Date.now();
    const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', timeout: name === 'Docker verification' ? 900000 : 180000, windowsHide: true });
    let passed = result.status === 0 && !result.error;
    if (passed && name === 'Docker verification') {
      const docker = JSON.parse(readFileSync(join(root, '../docker-verification.json'), 'utf8'));
      passed = docker.passed === true && Date.parse(docker.startedAt) >= start - 1000;
    }
    report.stages.push({ name, passed, seconds: Math.round((Date.now() - start) / 1000), exitCode: result.status, spawnError: result.error?.code });
    if (!passed) { process.exitCode = 1; break; }
  }
  report.passed = report.stages.length === stages.length && report.stages.every(stage => stage.passed);
} finally {
  report.finishedAt = new Date().toISOString();
  const body = JSON.stringify(report, null, 2) + '\n';
  writeFileSync(join(root, 'verification', `local-${stamp}.json`), body);
  writeFileSync(join(root, 'verification', 'local-latest.json'), body);
  console.log(`\n${report.passed ? 'PASS' : 'FAIL'}: verification/local-latest.json`);
  console.log('Live Yahoo, deployment, and ChatGPT OAuth are separate gates.');
}
