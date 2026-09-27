import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render } from '../../src/setup/messages.js';
import { createPrompt } from '../../src/setup/prompt.js';
import { createCanary } from '../../testkit/src/canary.js';

describe('the setup prompt', () => {
  it('SET-22 password prompts don\'t echo, and say so', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', chunk => { shown += chunk.toString(); });
    const prompt = createPrompt(input, output);
    const password = createCanary('app-password');

    const hidden = prompt.question(render('ASK-APP-PASSWORD'), { hidden: true });
    input.write(`${password}\n`);
    expect(await hidden).toBe(password);
    expect(shown).toContain('nothing shows while you paste');
    expect(shown).not.toContain(password);

    // An ordinary question does show what's typed.
    const name = prompt.question(render('ASK-NAME', { suggested: 'yahoo' }), { hidden: false });
    input.write('personal\n');
    expect(await name).toBe('personal');
    expect(shown).toContain('personal');
    prompt.close();
  });

  // Found live, 2026-09-27: in a real terminal, readline redraws the line it
  // waits on (ESC[1G ESC[0J: to column 1, erase), which wiped the question's
  // last line: "[Y/n] ›" and the address prompt "›" never showed. After every
  // redraw the question's last line must still be on screen.
  it('SET-22 a question\'s last line survives readline redrawing it (added: found live)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', chunk => { shown += chunk.toString(); });
    const prompt = createPrompt(input, output);
    const answer = prompt.question('  Update it?\n  version 1 keeps running. [Y/n] ›', { hidden: false });
    await new Promise(r => setImmediate(r));
    const afterLastErase = shown.slice(shown.lastIndexOf('\x1b[0J') + 1);
    expect(shown).toContain('  Update it?\n');
    expect(afterLastErase).toContain('version 1 keeps running. [Y/n] ›');
    input.write('n\r');
    expect(await answer).toBe('n');
    prompt.close();
  });

  // Found live, 2026-09-27: Ctrl+C at a question (easily pressed to copy text
  // from Cloud Shell) closed readline; the question was left waiting on nothing
  // and Node quit with "Detected unsettled top-level await". A closed input
  // must stop setup plainly, with its code, and say what closed it.
  it('SET-22 Ctrl+C at a question stops setup plainly instead of hanging (added: found live)', async () => {
    const input = new PassThrough();
    const heard: string[] = [];
    const prompt = createPrompt(input, new PassThrough(), reason => heard.push(reason));
    const answer = prompt.question('  ›', { hidden: false });
    input.write('\x03');
    await expect(answer).rejects.toMatchObject({ code: 'SETUP-INTERRUPTED' });
    expect(heard).toEqual(['ctrl-c']);
    // Asked again after that: the same plain stop, never readline's own error.
    await expect(prompt.question('  ›', { hidden: false })).rejects.toMatchObject({ code: 'SETUP-INTERRUPTED' });
  });

  it('SET-22 the input ending (Ctrl+D, or a closed pipe) at a question stops setup the same way', async () => {
    const input = new PassThrough();
    const heard: string[] = [];
    const prompt = createPrompt(input, new PassThrough(), reason => heard.push(reason));
    const answer = prompt.question('  ›', { hidden: true });
    input.end();
    await expect(answer).rejects.toMatchObject({ code: 'SETUP-INTERRUPTED' });
    expect(heard).toEqual(['input-closed']);
  });
});

describe('what setup needs to run', () => {
  it('SET-25 setup needs nothing beyond Node\'s built-in modules', () => {
    const src = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
    const seen = new Set<string>();
    const outside: string[] = [];
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/^\s*(import|export)\s+(?!type\b)[^'"]*?from\s+'([^']+)'/gm)) {
        const specifier = match[2]!;
        if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
        else if (!specifier.startsWith('node:')) outside.push(`${file.slice(src.length)} imports ${specifier}`);
      }
    };
    for (const f of readdirSync(join(src, 'setup'))) if (f.endsWith('.ts')) visit(join(src, 'setup', f));
    expect(seen.size).toBeGreaterThan(5);
    expect(outside).toEqual([]);
  });
});
