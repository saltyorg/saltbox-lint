// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHostProcessSupervisor } from "../scripts/host-process-supervisor.mjs";
import {
  createHostProfile,
  cleanupHostProfile,
} from "../scripts/host-fixture.mjs";
import {
  extensionDirectory,
  runHostProfile,
} from "../scripts/host-launcher.mjs";
import { groupHasLiveMembers } from "../scripts/owned-group.mjs";
import { ownedCommand } from "../scripts/owned-command.mjs";
import { reserveProcess } from "../src/process-reservation.ts";

/**
 * @param {import('node:test').TestContext} t
 * @param {import('../scripts/host-process-supervisor.mjs').SupervisorOptions} [options]
 */
async function supervisorFor(t, options = {}) {
  const supervisor = await createHostProcessSupervisor({
    platform: "linux",
    observeGroup: async () => false,
    ...options,
  });
  assert.ok(supervisor);
  t.after(async () => {
    await supervisor.finish().catch(() => {});
  });
  return supervisor;
}

/** @param {import('node:net').Socket} socket */
function socketLifetime(socket) {
  /** @type {Error[]} */
  const errors = [];
  /** @param {Error} error */
  const observeError = (error) => errors.push(error);
  socket.on("error", observeError);
  // events.once rejects on error; that is not proof of socket closure.
  const closed = /** @type {Promise<void>} */ (
    new Promise((resolve) => {
      socket.once("close", () => {
        socket.removeListener("error", observeError);
        resolve();
      });
    })
  );
  return {
    closed,
    errors,
    /** @param {boolean} [allowReset] */
    async join(allowReset = false) {
      await closed;
      const unexpected = errors.filter(
        (error) =>
          !allowReset || !("code" in error) || error.code !== "ECONNRESET",
      );
      if (unexpected.length === 1) throw unexpected[0];
      if (unexpected.length > 1)
        throw new AggregateError(unexpected, "ownership socket failed");
    },
  };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {Pick<import('../scripts/host-process-supervisor.mjs').HostProcessSupervisor, 'environment'>} supervisor
 * @param {boolean} [allowReset]
 */
async function socketFor(t, supervisor, allowReset = false) {
  const configuration = JSON.parse(supervisor.environment);
  const [host, port] = configuration.address.split(":");
  const socket = connect({ host, port: Number(port) });
  const lifetime = socketLifetime(socket);
  t.after(async () => {
    socket.destroy();
    await lifetime.join(allowReset);
  });
  let control = "";
  socket.on("data", (data) => {
    control += data;
    let newline;
    while ((newline = control.indexOf("\n")) >= 0) {
      const line = control.slice(0, newline);
      control = control.slice(newline + 1);
      if (JSON.parse(line).stop === true) socket.end();
    }
  });
  await once(socket, "connect");
  return { socket, configuration, ...lifetime };
}

for (const [
  code,
  allowReset,
  accepted,
] of /** @type {[string, boolean, boolean][]} */ ([
  ["ECONNRESET", false, false],
  ["ECONNRESET", true, true],
  ["EPIPE", true, false],
])) {
  test(`socket error ${code} joins actual close with reset allowance ${allowReset}`, async (t) => {
    /** @type {import('node:net').Socket | undefined} */
    let socket;
    /** @type {ReturnType<typeof socketLifetime> | undefined} */
    let lifetime;
    /** @type {import('node:net').Socket | undefined} */
    let remote;
    /** @type {ReturnType<typeof socketLifetime> | undefined} */
    let remoteLifetime;
    const server = createServer((peer) => {
      remote = peer;
      remoteLifetime = socketLifetime(peer);
    });
    t.after(async () => {
      socket?.destroy();
      remote?.destroy();
      const cleanup = await Promise.allSettled([
        lifetime?.closed,
        remoteLifetime?.join(),
        server[Symbol.asyncDispose](),
      ]);
      const failures = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(failures, "socket fixture cleanup failed");
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const connected = once(server, "connection");
    socket = connect({ host: "127.0.0.1", port: address.port });
    lifetime = socketLifetime(socket);
    await once(socket, "connect");
    await connected;
    let closeObserved = false;
    socket.once("close", () => {
      closeObserved = true;
    });
    const failure = Object.assign(new Error(`owned socket ${code}`), { code });
    socket.once("error", () => {
      assert.equal(closeObserved, false, "error is not a socket-close receipt");
    });
    const joined = lifetime.join(allowReset);
    const outcome = accepted
      ? assert.doesNotReject(joined)
      : assert.rejects(joined, (error) => {
          assert.equal(
            closeObserved,
            true,
            "report failure after actual close",
          );
          return error === failure;
        });
    socket.destroy(failure);
    await outcome;
    assert.equal(closeObserved, true);
    assert.deepEqual(lifetime.errors, [failure]);
    assert.equal(socket.listenerCount("error"), 0);
  });
}

/** @param {import('node:net').Socket} socket @returns {Promise<Record<string, unknown>>} */
function lineFrom(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      socket.removeListener("data", data);
      socket.removeListener("close", close);
      socket.removeListener("error", error);
    };
    /** @param {Error} failure */
    const error = (failure) => {
      cleanup();
      reject(failure);
    };
    const close = () => {
      cleanup();
      reject(new Error("ownership peer closed before line"));
    };
    /** @param {Buffer | string} bytes */
    const data = (bytes) => {
      buffer += bytes;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        cleanup();
        resolve(JSON.parse(buffer.slice(0, newline)));
      }
    };
    socket.on("data", data).once("close", close).once("error", error);
  });
}

/** @param {import('node:test').TestContext} t @param {import('../scripts/host-process-supervisor.mjs').HostProcessSupervisor} supervisor @param {number} [pid] */
async function register(t, supervisor, pid = 1000) {
  const owner = await reserveProcess(
    supervisor.environment,
    new AbortController().signal,
  );
  t.after(async () => {
    await owner.completeJoinedChild(pid).catch(() => {});
  });
  const peer = await socketFor(t, supervisor);
  const { nonce } = JSON.parse(owner.environment);
  const accepted = lineFrom(peer.socket);
  peer.socket.write(
    JSON.stringify({
      token: peer.configuration.token,
      type: "bind",
      nonce,
      pid,
      group: pid,
    }) + "\n",
  );
  assert.deepEqual(await accepted, { accepted: true });
  return { ...peer, owner, nonce };
}

test("registration ACK precedes payload and natural closure still requires group disappearance", async (t) => {
  /** @type {number[]} */
  const observed = [];
  const supervisor = await supervisorFor(t, {
    observeGroup: async (group) => {
      observed.push(group);
      return false;
    },
  });
  const peer = await register(t, supervisor, 1200);
  assert.equal(supervisor.registrationCount, 1);
  peer.socket.end();
  await peer.closed;
  assert.deepEqual(await supervisor.finish(), {
    reservations: 1,
    registrations: 1,
    groups: 1,
    released: true,
  });
  assert.deepEqual(observed, [1200]);
});

test("STOP uses the admitted connection and joins its closure before release", async (t) => {
  const supervisor = await supervisorFor(t);
  const peer = await register(t, supervisor, 1201);
  const stop = lineFrom(peer.socket);
  const release = supervisor.finish();
  assert.deepEqual(await stop, { stop: true });
  peer.socket.end();
  await peer.closed;
  assert.equal((await release).released, true);
});

for (const malformed of [
  "wrong token",
  "wrong group",
  "bad JSON",
  "oversized",
]) {
  test(`${malformed} registration cannot admit payload or establish release`, async (t) => {
    const supervisor = await supervisorFor(t);
    const peer = await socketFor(t, supervisor);
    const value =
      malformed === "wrong token"
        ? JSON.stringify({
            token: "invalid",
            type: "reserve",
            nonce: "b".repeat(64),
          }) + "\n"
        : malformed === "wrong group"
          ? JSON.stringify({
              token: peer.configuration.token,
              type: "bind",
              nonce: "b".repeat(64),
              pid: 1202,
              group: 1203,
            }) + "\n"
          : malformed === "bad JSON"
            ? "invalid\n"
            : malformed === "oversized"
              ? "x".repeat(2049)
              : '{"token":';
    peer.socket.write(value);
    if (malformed === "partial") peer.socket.end();
    await peer.closed;
    assert.equal(supervisor.registrationCount, 0);
    await assert.rejects(
      supervisor.finish(),
      /nested process ownership failed/,
    );
  });
}

test("an unacknowledged partial request cannot create a reservation or payload", async (t) => {
  const supervisor = await supervisorFor(t);
  const peer = await socketFor(t, supervisor);
  peer.socket.end('{"token":');
  await peer.closed;
  const release = await supervisor.finish();
  assert.equal(release.reservations, 0);
  assert.equal(release.released, true);
});

test("sealing joins a pending unacknowledged socket without fabricating a reservation", async (t) => {
  const supervisor = await supervisorFor(t);
  const peer = await socketFor(t, supervisor, true);
  const release = supervisor.finish();
  await peer.closed;
  assert.equal((await release).reservations, 0);
  assert.equal(supervisor.registrationCount, 0);
});

test("group observations stop and join when cleanup cannot establish disappearance", async (t) => {
  let active = 0;
  const supervisor = await supervisorFor(t, {
    cleanupTimeoutMs: 100,
    observeGroup: (_group, signal) =>
      new Promise((resolve) => {
        active++;
        signal.addEventListener(
          "abort",
          () => {
            active--;
            resolve(true);
          },
          { once: true },
        );
      }),
  });
  const peer = await register(t, supervisor, 1204);
  peer.socket.end();
  await peer.closed;
  await assert.rejects(supervisor.finish(), /cleanup exceeded/);
  assert.equal(active, 0, "no losing process observation outlives its owner");
});

test("explicit cancellation before spawn completes without inventing a native group", async (t) => {
  const supervisor = await supervisorFor(t);
  const owner = await reserveProcess(
    supervisor.environment,
    new AbortController().signal,
  );
  assert.equal(supervisor.reservationCount, 1);
  await owner.cancelNoChild();
  assert.deepEqual(await supervisor.finish(), {
    reservations: 1,
    registrations: 0,
    groups: 0,
    released: true,
  });
});

test("joined child before native binding still receives read-only group observation", async (t) => {
  /** @type {number[]} */
  const observed = [];
  const supervisor = await supervisorFor(t, {
    observeGroup: async (group) => {
      observed.push(group);
      return false;
    },
  });
  const owner = await reserveProcess(
    supervisor.environment,
    new AbortController().signal,
  );
  await owner.completeJoinedChild(1400);
  const release = await supervisor.finish();
  assert.equal(release.registrations, 0);
  assert.equal(release.groups, 1);
  assert.deepEqual(observed, [1400]);
});

test("a native bind without an acknowledged reservation cannot start payload", async (t) => {
  const supervisor = await supervisorFor(t);
  const peer = await socketFor(t, supervisor);
  peer.socket.write(
    JSON.stringify({
      token: peer.configuration.token,
      type: "bind",
      nonce: "c".repeat(64),
      pid: 1401,
      group: 1401,
    }) + "\n",
  );
  await peer.closed;
  assert.equal(supervisor.registrationCount, 0);
  await assert.rejects(supervisor.finish(), /nested process ownership failed/);
});

test("buffered bind after joined bootstrap cancellation is declined without losing ownership proof", async (t) => {
  const supervisor = await supervisorFor(t);
  const owner = await reserveProcess(
    supervisor.environment,
    new AbortController().signal,
  );
  const configuration = JSON.parse(owner.environment);
  await owner.completeJoinedChild(1402);
  const peer = await socketFor(t, supervisor);
  const declined = lineFrom(peer.socket);
  peer.socket.write(
    JSON.stringify({
      token: configuration.token,
      type: "bind",
      nonce: configuration.nonce,
      pid: 1402,
      group: 1402,
    }) + "\n",
  );
  assert.deepEqual(await declined, { accepted: false });
  await peer.closed;
  const release = await supervisor.finish();
  assert.equal(release.released, true);
  assert.equal(release.registrations, 0);
});

test("a dead spawner after reservation retains its profile before any native binding", async (t) => {
  const profile = createHostProfile({
    workspaceBase: process.env.SALTBOX_TEST_WORKSPACE_BASE,
  });
  t.after(() => {
    if (existsSync(profile.root)) cleanupHostProfile(profile);
  });
  await assert.rejects(
    runHostProfile(
      { env: { ...process.env } },
      {
        createProfile: () => profile,
        command: (name, _args, options) =>
          ownedCommand(
            name,
            [
              "--experimental-strip-types",
              "--input-type=module",
              "-e",
              `
      import { reserveProcess } from './src/process-reservation.ts';
      await reserveProcess(process.env.SALTBOX_LINT_EDITOR_SUPERVISOR, new AbortController().signal);
      process.kill(process.pid, 'SIGKILL');
    `,
            ],
            options,
          ),
        createSupervisor: () =>
          createHostProcessSupervisor({
            platform: "linux",
            observeGroup: async () => false,
          }),
        cleanupProfile: () =>
          assert.fail(
            "pre-bind ownership uncertainty forbids deleting the profile",
          ),
        report() {},
      },
    ),
    (error) =>
      error instanceof AggregateError &&
      "retainedProfile" in error &&
      error.retainedProfile === profile.root,
  );
  assert.ok(existsSync(profile.root));
});

test("nested ownership failure retains directories even after the outer owner joined", async (t) => {
  const profile = createHostProfile({
    workspaceBase: process.env.SALTBOX_TEST_WORKSPACE_BASE,
  });
  t.after(() => {
    if (existsSync(profile.root)) cleanupHostProfile(profile);
  });
  const failure = new Error("nested group release uncertain");
  await assert.rejects(
    runHostProfile(
      { env: {} },
      {
        createProfile: () => profile,
        command: async () => "",
        createSupervisor: async () => ({
          environment: "redacted fixture value",
          finish: async () => {
            throw failure;
          },
        }),
        cleanupProfile: () =>
          assert.fail("unreleased nested groups prevent directory deletion"),
        report() {},
      },
    ),
    (error) =>
      error === failure &&
      "retainedProfile" in failure &&
      failure.retainedProfile === profile.root,
  );
  assert.ok(existsSync(profile.root));
});

test("uncertain outer release revokes known nested channels without claiming complete release", async (t) => {
  const profile = createHostProfile({
    workspaceBase: process.env.SALTBOX_TEST_WORKSPACE_BASE,
  });
  t.after(() => {
    if (existsSync(profile.root)) cleanupHostProfile(profile);
  });
  const failure = Object.assign(new Error("outer release uncertain"), {
    ownershipReleased: false,
  });
  let joined = false;
  await assert.rejects(
    runHostProfile(
      { env: {} },
      {
        createProfile: () => profile,
        command: async () => {
          throw failure;
        },
        createSupervisor: async () => ({
          environment: "redacted fixture value",
          finish: async () => {
            joined = true;
          },
        }),
        cleanupProfile: () =>
          assert.fail("uncertain outer ownership prevents directory deletion"),
        report() {},
      },
    ),
    (error) =>
      error === failure &&
      "retainedProfile" in failure &&
      failure.retainedProfile === profile.root,
  );
  assert.equal(joined, true);
  assert.ok(existsSync(profile.root));
});

test("actual escaped Go guardian survives editor SIGKILL and is joined before profile deletion", async (t) => {
  if (process.platform === "win32") {
    assert.equal(
      await createHostProcessSupervisor(),
      undefined,
      "Windows retains its enclosing Job containment",
    );
    return;
  }
  const build = createHostProfile({
    workspaceBase: process.env.SALTBOX_TEST_WORKSPACE_BASE,
  });
  t.after(() => {
    if (existsSync(build.root)) cleanupHostProfile(build);
  });
  const fixture = join(build.root, "process-fixture");
  await ownedCommand(
    "go",
    ["build", "-o", fixture, "./test/testdata/process_fixture.go"],
    {
      phase: "native supervised fixture build",
      timeoutMs: 180000,
      cwd: extensionDirectory,
      env: { ...process.env, CGO_ENABLED: "0" },
    },
  );
  /** @type {number | undefined} */
  let group;
  /** @type {string | undefined} */
  let profileRoot;
  await assert.rejects(
    runHostProfile(
      {
        env: {
          ...process.env,
          SALTBOX_TEST_WORKSPACE_BASE: process.env.SALTBOX_TEST_WORKSPACE_BASE,
        },
      },
      {
        createSupervisor: async () => {
          const supervisor = await createHostProcessSupervisor();
          assert.ok(supervisor);
          supervisor.events.once("registered", (record) => {
            group = record.group;
            assert.ok(profileRoot);
            writeFileSync(join(profileRoot, "admitted"), "owned");
          });
          return supervisor;
        },
        command: (name, _args, options) => {
          assert.ok(options.env?.SALTBOX_TEST_PROFILE_ROOT);
          profileRoot = options.env.SALTBOX_TEST_PROFILE_ROOT;
          const script = `
        import { spawn } from 'node:child_process';
        import { watch } from 'node:fs';
        import { reserveProcess } from './src/process-reservation.ts';
        const reservation = await reserveProcess(process.env.SALTBOX_LINT_EDITOR_SUPERVISOR, new AbortController().signal);
        const observer = watch(process.env.SALTBOX_TEST_PROFILE_ROOT, (_event, filename) => {
          if (filename === 'admitted') { observer.close(); process.kill(process.pid, 'SIGKILL'); }
        });
        const cli = spawn(process.argv[1], [], { detached: true, stdio: ['pipe','ignore','ignore'], env: { ...process.env, SALTBOX_LINT_EDITOR_PROCESS: '1', SALTBOX_LINT_EDITOR_SUPERVISOR: reservation.environment } });
        cli.stdin.end('# hang');
      `;
          return ownedCommand(
            name,
            [
              "--experimental-strip-types",
              "--input-type=module",
              "-e",
              script,
              fixture,
            ],
            options,
          );
        },
        report() {},
      },
    ),
    (error) =>
      error instanceof Error &&
      "ownershipReleased" in error &&
      error.ownershipReleased === true &&
      /SIGKILL/.test(error.message),
  );
  assert.ok(
    typeof group === "number" && group > 1,
    "the actual Go fixture registered its escaped process group",
  );
  assert.equal(await groupHasLiveMembers(group), false);
  assert.ok(profileRoot);
  assert.equal(existsSync(profileRoot), false);
});

test("slow native bootstrap after spawner crash is retained and released through its live owner", async (t) => {
  if (process.platform === "win32") {
    assert.equal(await createHostProcessSupervisor(), undefined);
    return;
  }
  /** @type {import('node:net').Socket | undefined} */
  let bootstrap;
  /** @type {Promise<unknown> | undefined} */
  let closed;
  /** @type {number | undefined} */
  let pid;
  /** @type {import('node:net').Server | undefined} */
  let control;
  /** @type {import('../scripts/host-types.js').HostProfile | undefined} */
  let build;
  /** @type {import('../scripts/host-types.js').HostProfile | undefined} */
  let profile;
  t.after(async () => {
    if (bootstrap && !bootstrap.destroyed)
      bootstrap.write(JSON.stringify({ release: true }) + "\n");
    if (closed) await closed;
    if (control?.listening) {
      const server = control;
      await new Promise((resolve) => server.close(resolve));
    }
    if (pid)
      assert.equal(
        await groupHasLiveMembers(pid),
        false,
        "bootstrap release must join the actual native group",
      );
    if (profile && existsSync(profile.root)) cleanupHostProfile(profile);
    if (build && existsSync(build.root)) cleanupHostProfile(build);
  });
  build = createHostProfile({
    workspaceBase: process.env.SALTBOX_TEST_WORKSPACE_BASE,
  });
  profile = createHostProfile({
    workspaceBase: process.env.SALTBOX_TEST_WORKSPACE_BASE,
  });
  const fixture = join(build.root, "process-fixture");
  await ownedCommand(
    "go",
    ["build", "-o", fixture, "./test/testdata/process_fixture.go"],
    {
      phase: "slow bootstrap fixture build",
      timeoutMs: 180000,
      cwd: extensionDirectory,
      env: { ...process.env, CGO_ENABLED: "0" },
    },
  );
  const token = randomBytes(32).toString("hex");
  control = createServer((socket) => {
    bootstrap = socket;
    closed = once(socket, "close");
    lineFrom(socket)
      .then((ready) => {
        if (ready.token !== token)
          throw new Error("bootstrap credential did not match this instance");
        assert.ok(
          typeof ready.pid === "number" && Number.isSafeInteger(ready.pid),
        );
        pid = ready.pid;
        assert.ok(profile);
        writeFileSync(join(profile.root, "bootstrap-ready"), "owned");
      })
      .catch(() => socket.destroy());
  });
  const server = control;
  await /** @type {Promise<void>} */ (
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    })
  );
  const address = control.address();
  assert.ok(address && typeof address !== "string");
  const configuration = JSON.stringify({
    address: `127.0.0.1:${address.port}`,
    token,
  });
  /** @type {import('../scripts/host-process-supervisor.mjs').HostProcessSupervisor | undefined} */
  let supervisor;
  await assert.rejects(
    runHostProfile(
      {
        env: { ...process.env, SALTBOX_TEST_BOOTSTRAP_CONTROL: configuration },
      },
      {
        createProfile: () => {
          assert.ok(profile);
          return profile;
        },
        createSupervisor: async () => {
          supervisor = await createHostProcessSupervisor();
          return supervisor;
        },
        command: (name, _args, options) =>
          ownedCommand(
            name,
            [
              "--experimental-strip-types",
              "--input-type=module",
              "-e",
              `
      import { spawn } from 'node:child_process';
      import { watch } from 'node:fs';
      import { reserveProcess } from './src/process-reservation.ts';
      const reservation = await reserveProcess(process.env.SALTBOX_LINT_EDITOR_SUPERVISOR, new AbortController().signal);
      const observer = watch(process.env.SALTBOX_TEST_PROFILE_ROOT, (_event, filename) => {
        if (filename === 'bootstrap-ready') { observer.close(); process.kill(process.pid, 'SIGKILL'); }
      });
      const cli = spawn(process.argv[1], [], { detached:true, stdio:['pipe','ignore','ignore'], env: { ...process.env, SALTBOX_LINT_EDITOR_PROCESS:'1', SALTBOX_LINT_EDITOR_SUPERVISOR:reservation.environment } });
      cli.stdin.end('# hang');
    `,
              fixture,
            ],
            options,
          ),
        cleanupProfile: () =>
          assert.fail("unbound startup cannot authorize profile deletion"),
        report() {},
      },
    ),
    (error) =>
      error instanceof AggregateError &&
      "retainedProfile" in error &&
      error.retainedProfile === profile?.root,
  );
  assert.ok(typeof pid === "number" && pid > 1);
  assert.ok(supervisor);
  assert.equal(supervisor.reservationCount, 1);
  assert.equal(supervisor.registrationCount, 0);
  assert.equal(
    await groupHasLiveMembers(pid),
    true,
    "the stopped startup remains known uncertainty rather than fictional release",
  );
  assert.ok(existsSync(profile.root));
});
