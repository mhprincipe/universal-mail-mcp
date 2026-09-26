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
