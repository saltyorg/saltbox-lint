// @ts-check
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ownedCommand } from "../scripts/owned-command.mjs";
import { groupHasLiveMembers } from "../scripts/owned-group.mjs";
import {
  createHostProfile,
  cleanupHostProfile,
} from "../scripts/host-fixture.mjs";
import { withTestResources } from "./support/test-resources.ts";
import { ownJoinedResource } from "./support/host-resources.ts";

/**
 * @typedef {{pid: number, port: number, token: string}} NativeInstance
 * @typedef {{code: number | null, signal: NodeJS.Signals | null}} NativeClose
 * @typedef {{resources: import('./support/test-resources.ts').TestResources, binary: string, filename: string, groups: Set<number>}} NativeFixture
 */

/** @param {string} filename @param {AbortSignal} signal @returns {Promise<NativeInstance>} */
async function readInstance(filename, signal) {
  while (true) {
    signal.throwIfAborted();
    try {
      const value = /** @type {unknown} */ (
        JSON.parse(await readFile(filename, "utf8"))
      );
      assert.ok(value && typeof value === "object");
      assert.ok("pid" in value && Number.isSafeInteger(value.pid));
      assert.ok("port" in value && Number.isSafeInteger(value.port));
      assert.ok("token" in value && typeof value.token === "string");
      assert.ok(typeof value.pid === "number" && value.pid > 1);
      assert.ok(typeof value.port === "number" && value.port > 0);
      assert.match(value.token, /^[a-f0-9]{64}$/);
      return { pid: value.pid, port: value.port, token: value.token };
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    await delay(10, undefined, { signal });
  }
}

/** Read the exact credential or a refused endpoint, joining the actual socket. */
/** @param {NativeInstance} instance @param {AbortSignal} signal @param {string} [request] @returns {Promise<boolean>} */
function endpointAlive(instance, signal, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: instance.port });
    let response = "";
    /** @type {boolean | undefined} */
    let result;
    /** @type {unknown} */
    let failure;
    const cancel = () =>
      socket.destroy(
        new Error("native endpoint cancelled", {
          cause: signal.reason,
        }),
      );
    const deadline = setTimeout(
      () => socket.destroy(new Error("native endpoint exceeded 1000ms")),
      1000,
    );
    if (request) socket.once("connect", () => socket.end(request));
    socket.on("data", (data) => {
      response += data.toString("ascii");
      if (response.length > 65)
        socket.destroy(
          new Error("native endpoint response exceeded its bound"),
        );
    });
    socket.once("end", () => {
      if (response === instance.token + "\n") result = true;
      else failure = new Error("native endpoint credential was not confirmed");
      socket.destroy();
    });
    socket.once("error", (error) => {
      if ("code" in error && error.code === "ECONNREFUSED") result = false;
      else failure = error;
    });
    socket.once("close", () => {
      clearTimeout(deadline);
      signal.removeEventListener("abort", cancel);
      if (failure) reject(failure);
      else if (result !== undefined) resolve(result);
      else
        reject(new Error("native endpoint closed without a confirmed result"));
    });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

/** @param {Set<number>} groups @param {AbortSignal} signal */
async function joinGroups(groups, signal) {
  for (const group of groups) {
    while (await groupHasLiveMembers(group, signal))
      await delay(10, undefined, { signal });
  }
}

/** @param {import('node:test').TestContext} context @param {'thread' | 'zombie'} kind @param {(fixture: NativeFixture) => Promise<void>} body */
async function withNativeFixture(context, kind, body) {
  const profile = createHostProfile();
  let buildReleased = true;
  const groups = new Set();
  await withTestResources(
    { cleanupTimeoutMs: 5000, operationSignal: context.signal },
    async (resources) => {
      resources.defer("native fixture profile", async (signal) => {
        try {
          if (!buildReleased)
            throw new Error("native compiler ownership is uncertain");
          await joinGroups(groups, signal);
          cleanupHostProfile(profile);
        } catch (cause) {
          throw Object.assign(
            new Error(
              "native fixture profile retained after uncertain cleanup",
              { cause },
            ),
            { retainedProfile: profile.root },
          );
        }
      });
      const filename = join(profile.root, "instance.json");
      const binary = join(profile.root, "native-fixture");
      const source = fileURLToPath(
        new URL(
          `testdata/owned-${kind}.${kind === "thread" ? "c" : "go"}`,
          import.meta.url,
        ),
      );
      try {
        buildReleased = false;
        await resources.operation("native fixture build", (signal) =>
          ownedCommand(
            kind === "thread" ? "cc" : "go",
            kind === "thread"
              ? [
                  "-pthread",
                  "-Wall",
                  "-Wextra",
                  "-Werror",
                  "-o",
                  binary,
                  source,
                ]
              : ["build", "-o", binary, source],
            {
              phase: `${kind} lifetime fixture build`,
              timeoutMs: 30000,
              signal,
            },
          ),
        );
        buildReleased = true;
      } catch (error) {
        buildReleased =
          error instanceof Error &&
          "ownershipReleased" in error &&
          error.ownershipReleased === true;
        throw error;
      }
      await body({ resources, binary, filename, groups });
    },
  );
}

/** @param {NativeFixture} fixture @param {string} executable @param {string[]} args @param {import('node:child_process').SpawnOptions} options @param {(child: import('node:child_process').ChildProcess) => void} [stop] */
function ownedNative(
  fixture,
  executable,
  args,
  options,
  stop = (child) => child.stdin?.end(),
) {
  const child = spawn(executable, args, options);
  /** @type {Promise<NativeClose>} */
  const closed = new Promise((resolve, reject) => {
    /** @type {Error | undefined} */
    let failure;
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) =>
      failure ? reject(failure) : resolve({ code, signal }),
    );
  });
  closed.catch(() => {});
  ownJoinedResource(fixture.resources, "native fixture process", {
    dispose() {
      stop(child);
    },
    async join() {
      await closed;
    },
  });
  child.stderr?.resume();
  return { child, closed };
}

test(
  "native C fixture joins its group and socket after owner stdin EOF",
  { timeout: 15000 },
  async (context) => {
    if (process.platform === "win32") return;
    await withNativeFixture(context, "thread", async (f) => {
      const native = ownedNative(
        f,
        f.binary,
        [f.filename, randomBytes(32).toString("hex")],
        { detached: true, stdio: ["pipe", "ignore", "pipe"] },
      );
      assert.ok(native.child.pid);
      f.groups.add(native.child.pid);
      const instance = await readInstance(f.filename, f.resources.signal);
      assert.equal(
        await endpointAlive(instance, f.resources.signal, "probe\n"),
        true,
      );
      native.child.stdin?.end();
      assert.deepEqual(await native.closed, { code: null, signal: "SIGKILL" });
      assert.equal(await groupHasLiveMembers(instance.pid), false);
      assert.equal(await endpointAlive(instance, f.resources.signal), false);
    });
  },
);

test(
  "actual pipe-owner crash stops the C worker after its main thread has exited",
  { timeout: 15000 },
  async (context) => {
    if (process.platform === "win32") return;
    await withNativeFixture(context, "thread", async (f) => {
      const owner = ownedNative(
        f,
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { stdio: ["ignore", "pipe", "pipe"] },
        (child) => {
          child.kill("SIGKILL");
        },
      );
      assert.ok(owner.child.stdout);
      const lifetimePipe = owner.child.stdout;
      f.resources.defer("observer lifetime pipe", () => {
        lifetimePipe.destroy();
      });
      const native = ownedNative(
        f,
        f.binary,
        [f.filename, randomBytes(32).toString("hex")],
        { detached: true, stdio: [lifetimePipe, "ignore", "pipe"] },
        () => {
          owner.child.kill("SIGKILL");
        },
      );
      assert.ok(native.child.pid);
      f.groups.add(native.child.pid);
      const instance = await readInstance(f.filename, f.resources.signal);
      assert.equal(
        await endpointAlive(instance, f.resources.signal, "exit-main\n"),
        true,
      );
      assert.equal(await groupHasLiveMembers(instance.pid), true);
      owner.child.kill("SIGKILL");
      assert.deepEqual(await native.closed, { code: null, signal: "SIGKILL" });
      // The observer's inherited read endpoint remains explicitly owned until
      // the native fixture consumes EOF and closes. Release it before joining
      // the crashed owner's stdio; exit alone did not close this endpoint.
      lifetimePipe.destroy();
      assert.deepEqual(await owner.closed, { code: null, signal: "SIGKILL" });
      assert.equal(await groupHasLiveMembers(instance.pid), false);
      assert.equal(await endpointAlive(instance, f.resources.signal), false);
    });
  },
);

for (const mode of ["owner EOF", "parent crash"]) {
  test(
    `native zombie fixture stops its live child before exit-gate release after ${mode}`,
    { timeout: 15000 },
    async (context) => {
      if (process.platform === "win32") return;
      await withNativeFixture(context, "zombie", async (f) => {
        const parent = ownedNative(f, f.binary, ["parent", f.filename], {
          stdio: ["pipe", "ignore", "pipe"],
        });
        const instance = await readInstance(f.filename, f.resources.signal);
        f.groups.add(instance.pid);
        assert.equal(await endpointAlive(instance, f.resources.signal), true);
        if (mode === "owner EOF") parent.child.stdin?.end();
        else parent.child.kill("SIGKILL");
        assert.deepEqual(
          await parent.closed,
          mode === "owner EOF"
            ? { code: 2, signal: null }
            : { code: null, signal: "SIGKILL" },
        );
        await joinGroups(f.groups, f.resources.signal);
        assert.equal(await endpointAlive(instance, f.resources.signal), false);
      });
    },
  );
}
