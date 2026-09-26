import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MESSAGES, render, renderLine, type MessageCode } from '../../src/setup/messages.js';
import { createUi } from '../../src/setup/ui.js';

const setupDir = new URL('../../src/setup/', import.meta.url);
const sources = () => readdirSync(setupDir).filter(f => f.endsWith('.ts')).map(f => ({ file: f, text: readFileSync(join(setupDir.pathname.replace(/^\/([A-Za-z]:)/, '$1'), f), 'utf8') }));
const problems = () => (Object.keys(MESSAGES) as MessageCode[]).filter(code => MESSAGES[code].kind === 'problem');
const allText = () => (Object.keys(MESSAGES) as MessageCode[]).map(code => MESSAGES[code].kind === 'problem' ? render(code) : renderLine(code));

// Words a person who has never used a command line shouldn't have to meet.
// Stems (\w*) catch "deploying", "tokens" and the like; the rest are whole
// words, so "Click" isn't mistaken for "CLI".
const JARGON = ['IMAP', 'SMTP', 'OAuth', 'token\\w*', 'deploy\\w*', 'environment\\w*', 'APIs?', 'endpoint\\w*', 'container\\w*', 'Cloud Run',
  'Secret Manager', 'service accounts?', 'IAM', 'JSON', 'CLI', 'gcloud', 'repositor\\w*', 'stack trace', 'exception\\w*', 'undefined', 'null', 'config\\w*'];

describe('setup messages', () => {
  it('SET-01 every message a person sees comes from the registry', () => {
    // Only the UI module writes to the screen, and it only takes registry codes.
    for (const { file, text } of sources()) {
      if (file === 'ui.ts') continue;
      expect(text, file).not.toMatch(/console\.(log|error|warn|info)|process\.std(out|err)\.write/);
    }
    const ui = sources().find(s => s.file === 'ui.ts')!.text;
    expect(ui).toMatch(/say\(code: MessageCode/);
  });

  it('SET-02 every problem says what happened, the fix, where they stand, and a code', () => {
    expect(problems().length).toBeGreaterThan(10);
    for (const code of problems()) {
      const entry = MESSAGES[code];
      if (entry.kind !== 'problem') continue;
      expect(entry.what.trim(), code).not.toBe('');
      expect(entry.steps.length, code).toBeGreaterThan(0);
      expect(['nothing', 'saved', 'retry', 'retry-or-skip', 'continue-or-skip', 'handled'], code).toContain(entry.stand);
      expect(code).toMatch(/^(SETUP|GOOGLE|MAIL|SIGNIN|SENT)-[A-Z0-9-]+$/);
      const text = render(code);
      expect(text, code).toContain(`(${code})`);
      expect(text, code).toMatch(/Nothing was changed\.|Your progress is saved\.|Try again|Press Enter to continue|This was handled for you\./);
    }
  });

  it('SET-03 no user-facing text contains jargon', () => {
    for (const text of allText()) {
      for (const word of JARGON) {
        expect(new RegExp(`\\b${word}\\b`, 'i').test(text), `"${word}" in:\n${text}`).toBe(false);
      }
    }
  });

  it('SET-04 every message fits within 80 columns, as it appears on screen', () => {
    // Measured on what the screen shows, indent included.
    let screen = '';
    const ui = createUi({ write: text => { screen += text; } });
    for (const code of Object.keys(MESSAGES) as MessageCode[]) ui.say(code);
    // Including when a value is filled in.
    ui.say('MAIL-APP-PASSWORD', { provider: 'Fastmail', page: 'app.fastmail.com/settings/security', button: 'New app password' });
    for (const line of screen.split('\n')) expect([...line].length, line).toBeLessThanOrEqual(80);
  });
});
