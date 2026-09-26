import { describe, expect, it } from 'vitest';
import { createFakeClock } from '../src/fakeClock.js';

// TK-10: expiries, lapses and rate limits are tested by moving a clock, never
// by waiting for real time to pass.
describe('TK-10 fake clock', () => {
  it('only moves when told to, and by exactly the amount given', async () => {
    const clock = createFakeClock(new Date('2026-09-24T12:00:00.000Z'));
    const start = clock.now();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(clock.now()).toBe(start);

    clock.advance(10 * 60_000);
    expect(new Date(clock.now()).toISOString()).toBe('2026-09-24T12:10:00.000Z');
    clock.advance(1);
    expect(clock.now() - start).toBe(600_001);
  });
});
