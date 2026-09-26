// Operator-run first main-account check: folder listing only, no SMTP.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/src/config.js';
import { ImapGateway } from '../dist/src/yahoo/imap.js';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
const reportPath = fileURLToPath(new URL('../../main-folder-check.json', import.meta.url));
const report = { operation: 'list_folders', passed: false, startedAt: new Date().toISOString(), messageBodiesRead: false, mailMutated: false, smtpUsed: false };
let deadline;
let progress;
function save() { writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }
async function ask(prompt, hidden = false) {
  const output = hidden ? new Writable({ write(_chunk, _encoding, callback) { callback(); } }) : process.stdout;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  if (hidden) process.stdout.write(prompt);
  try {
    return await new Promise((resolve, reject) => {
      rl.once('SIGINT', () => reject(new Error('cancelled')));
      rl.question(hidden ? '' : prompt, resolve);
    });
  } finally { rl.close(); if (hidden) process.stdout.write('\n'); }
}
try {
  if (!process.stdin.isTTY) throw new Error('interactive-terminal-required');
  if (existsSync(envPath)) throw new Error('existing-env');
  console.log('This check connects to Yahoo IMAP and lists folders only.');
  console.log('The app password will be saved in the ignored local .env file; sending stays disabled.');
  const email = (await ask('Main Yahoo email address: ')).trim();
  const password = (await ask('Yahoo APP password (hidden): ', true)).replace(/\s/g, '');
  if (!/^[a-zA-Z0-9]{8,128}$/.test(password)) throw new Error('invalid-password-format');
  const values = {
    NODE_ENV: 'test', PORT: '8080', YAHOO_EMAIL: email, YAHOO_APP_PASSWORD: password,
    MCP_ACCESS_SECRET: randomBytes(32).toString('hex'), SENT_COPY_MODE: 'unverified',
    IMAP_HOST: 'imap.mail.yahoo.com', IMAP_PORT: '993', SMTP_HOST: 'smtp.mail.yahoo.com', SMTP_PORT: '587',
    ALLOWED_HOSTS: 'localhost,127.0.0.1', ALLOWED_ORIGINS: ''
  };
  const config = loadConfig(values);
  // Serialize only validated values. Never echo or include credentials in reports.
  writeFileSync(envPath, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  report.stage = 'connecting-for-folder-list';
  save();
  console.log('Connecting for folder listing. No messages will be downloaded or changed.');
  deadline = setTimeout(() => {
    report.stage = 'timeout'; report.finishedAt = new Date().toISOString(); save();
    console.error('Folder check timed out. Credentials were saved; do not rerun setup. Ask Codex to inspect the report.');
    process.exit(1);
  }, 60000);
  progress = setInterval(() => console.log('Waiting for Yahoo folder listing...'), 15000);
  const folders = await new ImapGateway(config).listFolders();
  report.passed = true;
  report.stage = 'complete';
  report.folderCount = folders.length;
  report.selectableFolderCount = folders.filter(folder => folder.selectable).length;
  report.specialRoles = [...new Set(folders.filter(folder => folder.selectable).map(folder => folder.specialUse).filter(Boolean))];
  console.log(`PASS: listed ${folders.length} folders. No messages read, changed, or sent.`);
} catch (error) {
  report.stage = 'failed';
  const safeErrors = new Map([
    ['existing-env', 'A local .env already exists and was not overwritten. Ask Codex to continue from it.'],
    ['interactive-terminal-required', 'Run this in a normal PowerShell window.'],
    ['invalid-password-format', 'The app-password format was not recognized. No credentials were saved.'],
    ['cancelled', 'Check cancelled.']
  ]);
  report.error = error?.name === 'ZodError' ? 'The account details did not pass validation; no credentials were saved.'
    : safeErrors.get(error?.message) ?? (error?.code === 'AUTH_FAILED' ? 'Yahoo rejected the app credentials.' : 'The folder check failed. No messages were read, changed, or sent.');
  console.error(report.error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline); clearInterval(progress);
  report.finishedAt = new Date().toISOString(); save();
  console.log(`Result saved to ${reportPath}`);
}
