export type FakeClock = { now(): number; advance(ms: number): void };

// Holds its own time: it starts where it's told and moves only by advance().
export function createFakeClock(start: Date): FakeClock {
  let current = start.getTime();
  return {
    now: () => current,
    advance: ms => { current += ms; }
  };
}
