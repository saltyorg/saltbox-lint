// @ts-check
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { ownedCommand } from "../scripts/owned-command.mjs";
import { installGoTool, runGoToolCLI } from "../../tools/install-go-tool.mjs";
import { withTestResources } from "./support/test-resources.ts";

const executable = fileURLToPath(
  new URL("testdata/go-tool-fixture.mjs", import.meta.url),
);
const target = "example.test/pinned-tool@v1.2.3";
/** @typedef {import('../../tools/install-go-tool.mjs').InstallOptions} InstallOptions */
/** @typedef {import('../../tools/install-go-tool.mjs').InstallCommandOptions} InstallCommandOptions */
/** @typedef {import('../scripts/owned-command.mjs').CommandOutput} CommandOutput */
/** @typedef {import("../scripts/owned-command.mjs").OwnedCommandDependencies} NativeAdapters */
/** @typedef {<T>(admit:(adapters:NativeAdapters)=>Promise<T>, adapters?:NativeAdapters)=>Promise<T>} NativeOperation */
/** @typedef {{target:string, attempt:number, args:string[], gobin:string, priorAbsent:boolean|null}} Receipt */
/** @typedef {{root:string,state:string,gobin:string,env:NodeJS.ProcessEnv,signal:AbortSignal,cancel:(reason:Error)=>void,owner:import('./support/test-resources.ts').TestResources,errors:unknown[],native:NativeOperation,outputs:{stream:'stdout'|'stderr',text:string}[],run:(args:string[],options:InstallCommandOptions,adapters?:NativeAdapters)=>Promise<CommandOutput>,records:()=>Promise<Receipt[]>,install:(options?:InstallOptions,dependencies?:import('../../tools/install-go-tool.mjs').InstallDependencies)=>Promise<{attempts:import('../../tools/install-go-tool.mjs').InstallAttempt[]}>}} Fixture */

/** @param {string[]} plan @param {(fixture:Fixture)=>Promise<void>} body */
async function withFixture(plan, body) {
  const cancellation = new AbortController();
  await withTestResources(
    { cleanupTimeoutMs: 5000, operationSignal: cancellation.signal },
    async (owner) => {
      const base = process.env.SALTBOX_TEST_REPOSITORY_BASE ?? tmpdir();
      await mkdir(base, { recursive: true });
      const root = await mkdtemp(join(base, "saltbox-go-tool-"));
      /** @type {unknown[]} */ const uncertain = [];
      owner.defer("tool inputs", async () => {
        if (uncertain.length)
          throw new AggregateError(
            uncertain,
            `Retained unverified tool inputs: ${root}`,
            { cause: uncertain[0] },
          );
        await rm(root, { recursive: true, force: true });
      });
      /** @type {NativeOperation} */
      const native = async (admit, adapters = {}) => {
        let admitted = false;
        try {
          return await admit({
            ...adapters,
            onSpawn(child) {
              admitted = true;
              adapters.onSpawn?.(child);
            },
          });
        } catch (error) {
          // Observe actual settlement before any consumer changes test metadata.
          if (
            admitted &&
            !(
              error instanceof Error &&
              "ownershipReleased" in error &&
              error.ownershipReleased === true
            )
          )
            uncertain.push(error);
          throw error;
        }
      };
      const state = join(root, "attempts.jsonl"),
        gobin = join(root, "bin");
      const env = {
        ...process.env,
        GOBIN: gobin,
        SALTBOX_TOOL_FIXTURE_STATE: state,
        SALTBOX_TOOL_FIXTURE_PLAN: JSON.stringify(plan),
      };
      /** @type {unknown[]} */
      const errors = [];
      /** @type {{stream:'stdout'|'stderr',text:string}[]} */
      const outputs = [];
      /** @param {string[]} args @param {InstallCommandOptions} options @param {NativeAdapters} [adapters] */
      const run = async (args, options, adapters = {}) => {
        try {
          return await native(
            (nativeAdapters) =>
              ownedCommand(
                process.execPath,
                [executable, ...args],
                options,
                nativeAdapters,
              ),
            adapters,
          );
        } catch (error) {
          errors.push(error);
          throw error;
        }
      };
      /** @returns {Promise<Receipt[]>} */
      const records = async () => {
        const source = await readFile(state, "utf8");
        return source
          .trim()
          .split("\n")
          .map((line) => {
            /** @type {unknown} */ const record = JSON.parse(line);
            assert.ok(
              record &&
                typeof record === "object" &&
                "args" in record &&
                Array.isArray(record.args) &&
                record.args.every((arg) => typeof arg === "string") &&
                "target" in record &&
                typeof record.target === "string" &&
                "gobin" in record &&
                typeof record.gobin === "string" &&
                "attempt" in record &&
                typeof record.attempt === "number" &&
                "priorAbsent" in record &&
                (record.priorAbsent === null ||
                  typeof record.priorAbsent === "boolean"),
            );
            return {
              target: record.target,
              args: record.args,
              gobin: record.gobin,
              attempt: record.attempt,
              priorAbsent: record.priorAbsent,
            };
          });
      };
      /** @param {InstallOptions} [options] @param {import('../../tools/install-go-tool.mjs').InstallDependencies} [dependencies] */
      const install = async (options = {}, dependencies = {}) => {
        // Expected installer rejection is a behavioral outcome; its admitted work
        // still settles under the real owner before the assertion consumes it.
        const outcome = await owner.operation("pinned tool install", () =>
          installGoTool(
            target,
            { env, signal: owner.signal, ...options },
            {
              runInstall: run,
              write: (stream, text) => outputs.push({ stream, text }),
              ...dependencies,
            },
          ).then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error }),
          ),
        );
        if (!outcome.ok && "error" in outcome) throw outcome.error;
        if (!("value" in outcome)) throw new Error("Missing installer outcome");
        return outcome.value;
      };
      await body({
        root,
        state,
        gobin,
        env,
        signal: owner.signal,
        cancel: (reason) => cancellation.abort(reason),
        owner,
        errors,
        outputs,
        native,
        run,
        records,
        install,
      });
    },
  );
}

/** Observe actual fixture admission, with settlement joined even on early failure. */
/** @param {Fixture} fixture @param {()=>void} trigger @param {InstallOptions} [options] */
async function afterAdmission(fixture, trigger, options = {}) {
  const token = randomBytes(32).toString("hex");
  /** @type {(value:{ready:boolean,error?:unknown})=>void} */ let settle;
  /** @type {Promise<{ready:boolean,error?:unknown}>} */ const readiness =
    new Promise((resolve) => {
      settle = resolve;
    });
  /** @type {(()=>void)[]} */ const remove = [];
  /** @type {unknown[]} */ const failures = [];
  /** @type {unknown[]} */ const observed = [];
  /** @type {unknown} */ let consumed;
  let sealed = false;
  const release = () => {
    if (sealed) return;
    sealed = true;
    settle({ ready: false });
    for (const dispose of remove)
      try {
        dispose();
      } catch (error) {
        failures.push(error);
      }
    remove.length = 0;
  };
  fixture.owner.defer("tool readiness stdout observer", () => {
    release();
    const unexpected = [
      ...observed.filter((error) => error !== consumed),
      ...failures,
    ];
    if (unexpected.length)
      throw new AggregateError(unexpected, "Readiness observer cleanup failed");
  });
  /** @type {Promise<{ok:true,value:{attempts:import('../../tools/install-go-tool.mjs').InstallAttempt[]}}|{ok:false,error:unknown}>|undefined} */ let outcome;
  /** @type {unknown} */ let bodyFailure;
  let failed = false;
  /** @type {Awaited<NonNullable<typeof outcome>>|undefined} */ let result;
  try {
    outcome = fixture
      .install(
        {
          ...options,
          env: {
            ...(options.env ?? fixture.env),
            SALTBOX_TOOL_FIXTURE_READY: token,
          },
        },
        {
          runInstall: (args, config) =>
            fixture.run(args, config, {
              onSpawn(child) {
                assert.ok(child.stdout);
                const stdout = child.stdout;
                let buffer = "",
                  admitted = false;
                const failure = (/** @type {unknown} */ error) => {
                  if (!sealed) {
                    if (!observed.includes(error)) observed.push(error);
                    settle({ ready: false, error });
                  }
                };
                const data = (/** @type {string} */ chunk) => {
                  if (sealed || admitted) return;
                  try {
                    buffer += chunk;
                    if (buffer.length > 512)
                      throw new Error("Oversized fixture readiness frame");
                    if (!buffer.endsWith("\n")) return;
                    if (buffer !== `SALTBOX_TOOL_READY ${token}\n`)
                      throw new Error("Invalid fixture readiness identity");
                    admitted = true;
                    settle({ ready: true });
                  } catch (error) {
                    failure(error);
                  }
                };
                // The native owner installed its capture/exit/pipe fences before this hook.
                remove.push(() => {
                  stdout.removeListener("data", data);
                  stdout.removeListener("error", failure);
                });
                stdout.on("data", data);
                stdout.on("error", failure);
              },
            }),
        },
      )
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
    const first = await Promise.race([
      readiness,
      outcome.then(() => ({ ready: false, settled: true })),
    ]);
    if ("settled" in first) {
      const native = await outcome;
      if (!native.ok) throw native.error;
      throw new Error("Held fixture exited before its native readiness frame");
    }
    if (!first.ready) {
      consumed =
        first.error ?? new Error("Fixture readiness closed before admission");
      throw consumed;
    }
    trigger();
    result = await outcome;
  } catch (error) {
    failed = true;
    bodyFailure = error;
  } finally {
    fixture.cancel(new Error("admission control released"));
    if (outcome) {
      const native = await outcome;
      if (
        failed &&
        !native.ok &&
        native.error !== bodyFailure &&
        !(
          native.error instanceof Error &&
          native.error.cause === fixture.signal.reason &&
          "ownershipReleased" in native.error &&
          native.error.ownershipReleased === true
        )
      )
        bodyFailure = new AggregateError(
          [bodyFailure, native.error],
          "Readiness and native operation failed",
          { cause: bodyFailure },
        );
    }
    release();
  }
  if (failed) throw bodyFailure;
  assert.ok(result);
  return result;
}

test("owned command opt-in returns both successful streams after native ownership settles", async () => {
  await withFixture(["success"], async (f) => {
    const result = await f.native((nativeAdapters) =>
      ownedCommand(
        process.execPath,
        [executable, "install", target],
        {
          phase: "tool output capture",
          captureOutput: true,
          env: f.env,
          signal: f.signal,
        },
        nativeAdapters,
      ),
    );
    assert.deepEqual(result, {
      stdout: "tool stdout 1\n",
      stderr: "tool stderr 1\n",
    });
  });
});

test("the imported pinned installer retries an owned module transport failure and preserves every attempt", async () => {
  await withFixture(["transient", "success"], async (f) => {
    const result = await f.install();
    assert.deepEqual(
      (await f.records()).map((record) => record.args),
      [
        ["install", target],
        ["install", target],
      ],
    );
    assert.deepEqual(
      (await f.records()).map((record) => record.gobin),
      [f.gobin, f.gobin],
    );
    assert.equal(
      await readFile(join(f.gobin, "pinned-tool"), "utf8"),
      "installed fixture\n",
    );
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.stdout),
      ["", "tool stdout 2\n"],
    );
    assert.equal(result.attempts[1].stderr, "tool stderr 2\n");
    assert.equal(result.attempts[0].error, f.errors[0]);
    assert.deepEqual(f.outputs, [
      { stream: "stdout", text: result.attempts[0].stdout },
      { stream: "stderr", text: result.attempts[0].stderr },
      { stream: "stdout", text: result.attempts[1].stdout },
      { stream: "stderr", text: result.attempts[1].stderr },
    ]);
  });
});

for (const mode of [
  "compile",
  "mixed",
  "mixed-stdout",
  "checksum",
  "auth",
  "not-found",
]) {
  test(`pinned installer does not retry ${mode} failures`, async () => {
    await withFixture([mode, "success"], async (f) => {
      await assert.rejects(f.install(), (error) => error === f.errors[0]);
      assert.equal((await f.records()).length, 1);
      assert.equal(existsSync(join(f.gobin, "pinned-tool")), false);
    });
  });
}

test("transport exhaustion retains the original first and final owned failures at three attempts", async () => {
  await withFixture(["transient"], async (f) => {
    await assert.rejects(f.install(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, f.errors);
      assert.equal(error.cause, f.errors[2]);
      return true;
    });
    assert.equal((await f.records()).length, 3);
    assert.equal(
      f.outputs.filter((record) => record.stream === "stderr").length,
      3,
    );
  });
});

test("a nontransport failure after a transient attempt remains the original terminal cause", async () => {
  await withFixture(["transient", "compile", "success"], async (f) => {
    await assert.rejects(f.install(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, f.errors);
      assert.equal(error.cause, f.errors[1]);
      return true;
    });
    assert.equal((await f.records()).length, 2);
  });
});

test("retry admission waits for a failed owner with live descendant pipes and endpoint to settle", async () => {
  await withFixture(["retained-pipe", "success"], async (f) => {
    await f.install();
    const records = await f.records();
    assert.equal(records.length, 2);
    assert.equal(records[1].priorAbsent, true);
  });
});

test("owned operation cancellation stops and joins the admitted installer without retry", async () => {
  await withFixture(["hold"], async (f) => {
    const outcome = await afterAdmission(f, () =>
      f.cancel(new Error("cancel requested")),
    );
    assert.equal(outcome.ok, false);
    assert.equal((await f.records()).length, 1);
    assert.equal(f.errors.length, 1);
  });
});

test("an owned deadline remains terminal and joins the admitted fixture without retry", async () => {
  await withFixture(["hold"], async (f) => {
    const outcome = await afterAdmission(f, () => {}, { timeoutMs: 5000 });
    assert.equal(outcome.ok, false);
    assert.equal((await f.records()).length, 1);
    assert.equal(f.errors.length, 1);
  });
});

test("the overall installation budget is not restarted for another attempt", async () => {
  await withFixture(["transient", "success"], async (f) => {
    let time = 0;
    await assert.rejects(
      f.install(
        {},
        {
          now: () => time,
          runInstall: async (args, options) => {
            try {
              return await f.run(args, options);
            } finally {
              time = 300001;
            }
          },
        },
      ),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], f.errors[0]);
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, /overall budget/);
        return true;
      },
    );
    assert.equal((await f.records()).length, 1);
  });
});

test("a retry receives only the unspent installation budget", async () => {
  await withFixture(["transient", "success"], async (f) => {
    let time = 0;
    /** @type {number[]} */
    const limits = [];
    await f.install(
      {},
      {
        now: () => time,
        runInstall: async (args, options) => {
          assert.ok(options.timeoutMs !== undefined);
          limits.push(options.timeoutMs);
          try {
            return await f.run(args, options);
          } finally {
            time = 90000;
          }
        },
      },
    );
    assert.deepEqual(limits, [300000, 210000]);
  });
});

test("unknown ownership and independent cleanup failures cannot authorize retries", async () => {
  for (const mode of ["unknown", "cleanup"])
    await withFixture(["transient", "success"], async (f) => {
      const cleanup = new Error("independent owned cleanup failure");
      /** @type {unknown} */
      let original;
      await assert.rejects(
        f.install(
          {},
          {
            runInstall: async (args, options) => {
              try {
                return await f.run(args, options);
              } catch (error) {
                original = error;
                if (mode === "unknown") {
                  assert.ok(error instanceof Error);
                  Object.assign(error, { ownershipReleased: false });
                  throw error;
                }
                throw new AggregateError(
                  [error, cleanup],
                  "actual owner and cleanup failed",
                  { cause: error },
                );
              }
            },
          },
        ),
        (error) => {
          if (mode === "unknown") assert.equal(error, original);
          else {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [original, cleanup]);
            assert.equal(error.cause, original);
          }
          return true;
        },
      );
      assert.equal((await f.records()).length, 1);
    });
});

test("output failures retain the download failure and attempt both original streams without retry", async () => {
  await withFixture(["transient", "success"], async (f) => {
    const writer = new Error("output consumer failed");
    /** @type {string[]} */
    const streams = [];
    await assert.rejects(
      f.install(
        {},
        {
          write: (stream) => {
            streams.push(stream);
            throw writer;
          },
        },
      ),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, f.errors[0]);
        assert.equal(error.errors[0], f.errors[0]);
        assert.ok(error.errors[1] instanceof AggregateError);
        assert.deepEqual(error.errors[1].errors, [writer, writer]);
        return true;
      },
    );
    assert.deepEqual(streams, ["stdout", "stderr"]);
    assert.equal((await f.records()).length, 1);
  });
});

test("captured output mode rejects incompatible modes before any owner or payload admission", async () => {
  await withFixture(["success"], async (f) => {
    for (const incompatible of [
      { stdio: "inherit" },
      { returnExitCode: true },
    ]) {
      await assert.rejects(
        f.native((nativeAdapters) =>
          Reflect.apply(ownedCommand, undefined, [
            process.execPath,
            [executable, "install", target],
            {
              phase: "invalid capture mode",
              env: f.env,
              captureOutput: true,
              ...incompatible,
            },
            nativeAdapters,
          ]),
        ),
        /requires captured pipes/,
      );
      assert.equal(existsSync(f.state), false);
    }
  });
});

test("default string and exit-code results remain unchanged alongside the opt-in", async () => {
  await withFixture(["success"], async (f) => {
    assert.equal(
      await f.native((nativeAdapters) =>
        ownedCommand(
          process.execPath,
          [executable, "install", target],
          {
            phase: "legacy stdout",
            env: f.env,
          },
          nativeAdapters,
        ),
      ),
      "tool stdout 1\n",
    );
    assert.equal(
      await f.native((nativeAdapters) =>
        ownedCommand(
          process.execPath,
          [executable, "install", target],
          {
            phase: "legacy code",
            env: f.env,
            returnExitCode: true,
          },
          nativeAdapters,
        ),
      ),
      0,
    );
  });
});

test("widened captured-output flags retain the actual metadata return type", async () => {
  await withFixture(["success"], async (f) => {
    const options = {
      phase: "widened capture",
      env: f.env,
      captureOutput: Boolean(f.gobin),
    };
    const result = await f.native((nativeAdapters) =>
      ownedCommand(
        process.execPath,
        [executable, "install", target],
        options,
        nativeAdapters,
      ),
    );
    assert.ok(result !== null && typeof result === "object");
    assert.equal(result.stderr, "tool stderr 1\n");
  });
});

for (const condition of ["deadline", "abort"]) {
  test(`successful joined tool cannot return success after ${condition}`, async () => {
    await withFixture(["transient", "success"], async (f) => {
      let time = 0;
      await assert.rejects(
        f.install(
          {},
          {
            now: () => time,
            runInstall: async (args, options) => {
              const result = await f.run(args, options);
              if (condition === "deadline") time = 300001;
              else f.cancel(new Error("cancel after actual owner join"));
              return result;
            },
          },
        ),
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors[0], f.errors[0]);
          assert.ok(error.cause instanceof Error);
          assert.match(
            error.cause.message,
            condition === "deadline" ? /overall budget/ : /cancelled/,
          );
          return true;
        },
      );
      assert.equal((await f.records()).length, 2);
    });
  });
}

test("a later clock fault preserves the first actual download failure", async () => {
  await withFixture(["transient", "success"], async (f) => {
    const clock = new Error("later clock failure");
    let failed = false;
    await assert.rejects(
      f.install(
        {},
        {
          now: () => {
            if (failed) throw clock;
            return 0;
          },
          runInstall: async (args, options) => {
            try {
              return await f.run(args, options);
            } finally {
              failed = true;
            }
          },
        },
      ),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [f.errors[0], clock]);
        assert.equal(error.cause, clock);
        return true;
      },
    );
    assert.equal((await f.records()).length, 1);
  });
});

for (const output of /** @type {const} */ (["stdout", "stderr"])) {
  test(
    `the executable boundary joins a reporter blocked on ${output} and retains complete output`,
    { timeout: 20000 },
    async () => {
      await withFixture([`large-${output}`], async (f) => {
        let blockedBytes = 0;
        let stdoutClosed = false,
          stderrClosed = false;
        const outcome = await f.owner.operation(
          "blocked output native owner",
          () =>
            f
              .native(
                (nativeAdapters) =>
                  ownedCommand(
                    process.execPath,
                    [executable, "--cli-driver"],
                    {
                      phase: "blocked tool CLI",
                      env: f.env,
                      signal: f.signal,
                      timeoutMs: 10000,
                      retainOutputOnError: true,
                    },
                    nativeAdapters,
                  ),
                {
                  onSpawn(child) {
                    assert.ok(child.stdout && child.stderr);
                    child.stdout.once("close", () => {
                      stdoutClosed = true;
                    });
                    child.stderr.once("close", () => {
                      stderrClosed = true;
                    });
                    const consumer = child[output];
                    assert.ok(consumer);
                    consumer.once("data", () => {
                      consumer.pause();
                    });
                    child.once("exit", () => {
                      blockedBytes = consumer.readableLength;
                      consumer.resume();
                    });
                  },
                },
              )
              .then(
                (value) => ({ ok: true, value }),
                (error) => ({ ok: false, error }),
              ),
        );
        assert.ok("error" in outcome && outcome.error instanceof Error);
        assert.ok(
          "ownershipReleased" in outcome.error &&
            outcome.error.ownershipReleased === true,
        );
        assert.ok("exitCode" in outcome.error && outcome.error.exitCode === 1);
        assert.ok(
          blockedBytes > 0,
          "the actual consumer remained blocked before the native owner exited",
        );
        assert.equal(stdoutClosed, true, "the actual stdout pipe closed");
        assert.equal(stderrClosed, true, "the actual stderr pipe closed");
        const raw = await readFile(f.state + ".result", "utf8");
        /** @type {unknown} */ const receipt = JSON.parse(raw);
        assert.ok(
          receipt &&
            typeof receipt === "object" &&
            "code" in receipt &&
            receipt.code === 1 &&
            "evidenceDirectory" in receipt &&
            typeof receipt.evidenceDirectory === "string",
        );
        /** @type {unknown} */ const retained = JSON.parse(
          await readFile(
            join(receipt.evidenceDirectory, "failure.json"),
            "utf8",
          ),
        );
        assert.ok(
          retained &&
            typeof retained === "object" &&
            "attemptOutputs" in retained &&
            Array.isArray(retained.attemptOutputs) &&
            retained.attemptOutputs.length === 1,
        );
        assert.equal(
          (await readFile(join(receipt.evidenceDirectory, `1.${output}.log`)))
            .length,
          2 * 1024 * 1024,
        );
        assert.equal((await f.records()).length, 1);
      });
    },
  );
}

test("the CLI retains original first, terminal and cleanup causes with full attempt file references", async () => {
  await withFixture(["transient", "compile"], async (f) => {
    const cleanup = new Error("independent cleanup token=private-value");
    const result = await runGoToolCLI(
      target,
      { env: f.env, signal: f.signal },
      {
        write: () => {},
        runInstall: async (args, options) => {
          try {
            return await f.run(args, options);
          } catch (error) {
            if (f.errors.length === 2)
              throw new AggregateError(
                [error, cleanup],
                "terminal plus cleanup",
                { cause: error },
              );
            throw error;
          }
        },
      },
    );
    assert.equal(result.code, 1);
    assert.ok("error" in result && result.error instanceof AggregateError);
    assert.equal(result.error.errors[0], f.errors[0]);
    assert.ok(result.error.errors[1] instanceof AggregateError);
    assert.deepEqual(result.error.errors[1].errors, [f.errors[1], cleanup]);
    assert.ok(
      "evidenceDirectory" in result &&
        typeof result.evidenceDirectory === "string",
    );
    const record = await readFile(
      join(result.evidenceDirectory, "failure.json"),
      "utf8",
    );
    assert.match(record, /terminal plus cleanup/);
    assert.match(record, /independent cleanup token=\[redacted\]/);
    assert.doesNotMatch(record, /private-value/);
    for (const number of [1, 2]) {
      assert.match(record, new RegExp(`${number}\\.stderr\\.log`));
      const actual = f.errors[number - 1];
      assert.ok(
        actual instanceof Error &&
          "stderr" in actual &&
          typeof actual.stderr === "string",
      );
      assert.equal(
        await readFile(
          join(result.evidenceDirectory, `${number}.stderr.log`),
          "utf8",
        ),
        actual.stderr,
      );
    }
  });
});

test("a post-spawn observer failure retains its original cause and joins the native owner", async () => {
  await withFixture(["hold"], async (f) => {
    const observation = new Error("actual owner observation failed");
    let called = 0,
      stdoutClosed = false,
      stderrClosed = false;
    await assert.rejects(
      f.native(
        (nativeAdapters) =>
          ownedCommand(
            process.execPath,
            [executable, "install", target],
            { phase: "observer failure", env: f.env, timeoutMs: 5000 },
            nativeAdapters,
          ),
        {
          onSpawn(child) {
            called++;
            assert.ok(child.stdout && child.stderr);
            child.stdout.once("close", () => {
              stdoutClosed = true;
            });
            child.stderr.once("close", () => {
              stderrClosed = true;
            });
            throw observation;
          },
        },
      ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, observation);
        assert.ok(
          "ownershipReleased" in error && error.ownershipReleased === true,
        );
        return true;
      },
    );
    assert.equal(called, 1);
    assert.equal(stdoutClosed, true);
    assert.equal(stderrClosed, true);
  });
});

test("a post-spawn observer can cancel through the already owned abort fence", async () => {
  await withFixture(["hold"], async (f) => {
    const cancelled = new Error("cancel inside actual owner observation");
    let calls = 0,
      stdoutClosed = false,
      stderrClosed = false;
    const outcome = await f.owner.operation(
      "observer-triggered owner cancellation",
      () =>
        f
          .native(
            (nativeAdapters) =>
              ownedCommand(
                process.execPath,
                [executable, "install", target],
                {
                  phase: "observer-triggered cancellation",
                  env: f.env,
                  signal: f.signal,
                  timeoutMs: 5000,
                },
                nativeAdapters,
              ),
            {
              onSpawn(child) {
                calls++;
                assert.ok(child.pid && child.stdout && child.stderr);
                child.stdout.once("close", () => {
                  stdoutClosed = true;
                });
                child.stderr.once("close", () => {
                  stderrClosed = true;
                });
                f.cancel(cancelled);
              },
            },
          )
          .then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error }),
          ),
    );
    assert.ok("error" in outcome && outcome.error instanceof Error);
    assert.equal(outcome.error.cause, cancelled);
    assert.ok(
      "ownershipReleased" in outcome.error &&
        outcome.error.ownershipReleased === true,
    );
    assert.equal(calls, 1);
    assert.equal(stdoutClosed, true);
    assert.equal(stderrClosed, true);
  });
});

test("early native failure preserves its original cause and joins the readiness listener", async () => {
  await withFixture(["compile"], async (f) => {
    let triggered = false;
    await assert.rejects(
      afterAdmission(f, () => {
        triggered = true;
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error, f.errors[0]);
        return true;
      },
    );
    assert.equal(triggered, false);
    assert.equal((await f.records()).length, 1);
  });
});
