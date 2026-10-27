import assert from "node:assert/strict";

/** Controlled editor file/refresh timers; each timer runs only when delivered. */
export function fileClock() {
  const timers: { perform(): void; active: boolean }[] = [];
  return {
    schedule(perform: () => void, milliseconds: number) {
      assert.equal(milliseconds, 100);
      const timer = { perform, active: true };
      timers.push(timer);
      return () => {
        timer.active = false;
      };
    },
    deliver() {
      const pending = timers.filter((timer) => timer.active);
      for (const timer of pending) {
        timer.active = false;
        timer.perform();
      }
      return pending.length;
    },
  };
}
export type FileClock = ReturnType<typeof fileClock>;

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Deliver admitted timers until the editor's public join observes quiescence.
 * Each round also awaits the editor's public context barrier, so asynchronous
 * context observations complete rather than consuming the round budget.
 * A producer that keeps re-queueing work fails instead of hanging; fixture
 * disposal then seals producers and its cleanup still owns that join.
 */
export async function settleFiles(
  editor: { join(): Promise<void>; settleContext?(): Promise<void> },
  timer: FileClock,
): Promise<void> {
  let joined = false;
  const pending = editor.join().then(() => {
    joined = true;
  });
  for (let round = 0; round < 2000 && !joined; round++) {
    timer.deliver();
    await editor.settleContext?.();
    await turn();
  }
  if (!joined) {
    pending.catch(() => undefined);
    assert.fail("background file work did not become quiescent");
  }
  await pending;
}
