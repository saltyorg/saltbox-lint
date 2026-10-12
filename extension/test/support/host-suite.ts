import type Mocha from "mocha";
import { withTestResources, type TestResources } from "./test-resources.ts";

export interface HostCase {
  name: string;
  exercise(resources: TestResources): Promise<void>;
}

/** Cases finish their owned cleanup before Mocha receives their outcome. */
export async function runHostSuite(
  profile: string,
  preflight: () => Promise<void>,
  cases: readonly HostCase[],
  options: {
    reporter?: Mocha.MochaOptions["reporter"];
    timeoutMs?: number;
  } = {},
): Promise<void> {
  // Mocha 12 is ESM. Native import preserves its default export in both the
  // minimum editor's Node 20 and the external Node 24 build/test runtime.
  const { default: Mocha } = await import("mocha");
  const mocha = new Mocha({
    ui: "tdd",
    color: false,
    timeout: options.timeoutMs ?? 180000,
    retries: 0,
    forbidOnly: true,
    forbidPending: true,
    asyncOnly: true,
    reporter: options.reporter ?? "spec",
    bail: true,
  });
  const suite = Mocha.Suite.create(
    mocha.suite,
    `installed extension: ${profile}`,
  );
  const admitted: Promise<void>[] = [];
  const owners = new Map<Mocha.Runnable, TestResources>();
  const owned = (perform: () => Promise<void>) => () => {
    const pending = Promise.resolve().then(perform);
    admitted.push(pending);
    return pending;
  };
  suite.addTest(
    new Mocha.Test(
      "loads the exact editor and packaged backend",
      owned(preflight),
    ),
  );
  for (const scenario of cases) {
    const test: Mocha.Test = new Mocha.Test(
      scenario.name,
      owned(async () => {
        try {
          await withTestResources({ cleanupTimeoutMs: 15000 }, (resources) => {
            owners.set(test, resources);
            return scenario.exercise(resources);
          });
        } finally {
          owners.delete(test);
        }
      }),
    );
    suite.addTest(test);
  }
  const failures: unknown[] = [];
  try {
    const count = await new Promise<number>((resolve) => {
      const runner = mocha.run(resolve);
      runner.on("fail", (test, error) => {
        owners.get(test)?.cancel(error);
        failures.push(error);
      });
    });
    // A Mocha timeout reports before an async function settles. Joining here
    // prevents the caller from treating that report as resource release.
    const results = await Promise.allSettled(admitted);
    for (const result of results) {
      if (result.status === "rejected" && !failures.includes(result.reason))
        failures.push(result.reason);
    }
    if (count || failures.length)
      throw new AggregateError(
        failures,
        `${count} extension host tests failed`,
      );
  } finally {
    mocha.dispose();
  }
}
