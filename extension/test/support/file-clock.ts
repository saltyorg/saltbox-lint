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
 * context observations complete before the next delivery.
 * A producer that keeps re-queueing work exhausts the delivery budget and fails
 * instead of hanging. Rounds that deliver nothing only wait for admitted file
 * I/O, whose duration depends on host load, so they are bounded by an idle
 * deadline rather than counted against that budget. Fixture disposal then seals
 * producers and its cleanup still owns the join.
 */
export async function settleFiles(
  editor: { join(): Promise<void>; settleContext?(): Promise<void> },
  timer: FileClock,
): Promise<void> {
  let joined = false;
  const pending = editor.join().then(() => {
    joined = true;
  });
  let deliveries = 0;
  let idleSince = Date.now();
  let failure = "";
  while (!joined) {
    if (timer.deliver() > 0) {
      idleSince = Date.now();
      if (++deliveries > 2000) {
        failure = "background file work kept re-queueing timers";
        break;
      }
    }
    await editor.settleContext?.();
    await turn();
    if (!joined && Date.now() - idleSince > 10_000) {
      failure = "background file work did not become quiescent within 10s";
      break;
    }
  }
  if (failure) {
    pending.catch(() => undefined);
    assert.fail(failure);
  }
  await pending;
}
