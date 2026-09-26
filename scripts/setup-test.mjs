// Saves local test credentials only; does not connect to Yahoo or send mail.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const email = process.argv[2]?.trim();
if (!email || !/^[a-zA-Z0-9._+-]+@yahoo\.com$/i.test(email)) throw new Error('Supply the disposable Yahoo email address as the argument.');
const target = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(target)) throw new Error('A .env file already exists. It was not overwritten.');
if (!process.stdin.isTTY) throw new Error('Run this from an interactive terminal.');
console.log(`Set up disposable test account: ${email}`);
console.log('This saves an ignored local .env file and does not connect to Yahoo.');
process.stdout.write('Paste the Yahoo APP password (input hidden), then press Enter: ');
const hidden = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
const rl = createInterface({ input: process.stdin, output: hidden, terminal: true });
let password;
try {
  password = await new Promise((resolve, reject) => {
    rl.once('SIGINT', () => reject(new Error('Setup cancelled.')));
    rl.question('', resolve);
  });
} finally { rl.close(); process.stdout.write('\n'); }
password = password.replace(/\s/g, '');
if (!/^[a-zA-Z0-9]{8,128}$/.test(password)) throw new Error('Unexpected app-password format. No file was saved.');
const token = randomBytes(32).toString('hex');
const values = [
  'NODE_ENV=test', 'PORT=8080', `YAHOO_EMAIL=${email}`, `YAHOO_APP_PASSWORD=${password}`,
  `MCP_ACCESS_SECRET=${token}`, 'SENT_COPY_MODE=unverified',
  'IMAP_HOST=imap.mail.yahoo.com', 'IMAP_PORT=993',
  'SMTP_HOST=smtp.mail.yahoo.com', 'SMTP_PORT=587',
  'ALLOWED_HOSTS=localhost,127.0.0.1', 'ALLOWED_ORIGINS='
];
writeFileSync(target, values.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
password = undefined;
console.log('Test credentials saved locally. Sends remain disabled. Tell Codex: Test setup saved.');
