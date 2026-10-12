// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownedCommand } from "../scripts/owned-command.mjs";
import { groupHasLiveMembers } from "../scripts/owned-group.mjs";
import {
  createHostProfile,
  cleanupHostProfile,
} from "../scripts/host-fixture.mjs";

/** @typedef {{socket: import('node:net').Socket, closed: Promise<unknown>, group?: number}} Peer */

/** @param {import('node:test').TestContext} t @param {number} expectedPeers */
async function lifetime(t, expectedPeers) {
  const profile = createHostProfile({
    workspaceBase: process.env.SALTBOX_TEST_WORKSPACE_BASE,
  });
  const token = randomBytes(32).toString("hex");
  /** @type {Peer[]} */
  const peers = [];
  let admitted = 0;
  let sealed = false;
  const server = createServer((socket) => {
    /** @type {Peer} */
    const peer = {
      socket,
      closed: new Promise((resolveClosed) =>
        socket.once("close", resolveClosed),
      ),
    };
    peers.push(peer);
    socket.on("error", () => {});
    if (sealed) {
      socket.destroy();
      return;
    }
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const message = JSON.parse(buffer.slice(0, newline));
      assert.equal(message.token, token);
      assert.ok(typeof message.group === "number" && message.group > 1);
      peer.group = message.group;
      socket.removeAllListeners("data");
      if (++admitted === expectedPeers)
        writeFileSync(join(profile.root, "ready"), "ready");
    });
  });
  t.after(async () => {
    const cancellation = new AbortController();
    const deadline = setTimeout(() => {
      cancellation.abort(new Error("guardian fixture cleanup exceeded 5000ms"));
      for (const peer of peers) peer.socket.destroy();
    }, 5000);
    sealed = true;
    const closed = new Promise((resolveClosed) => server.close(resolveClosed));
    for (const peer of peers) {
      if (!peer.socket.destroyed)
        peer.socket.end(JSON.stringify({ token, stop: true }) + "\n");
    }
    let released = false;
    try {
      await closed;
      await Promise.all(peers.map((peer) => peer.closed));
      assert.ok(
        peers.every((peer) => peer.group !== undefined),
        "an unidentified native lifetime remains uncertain",
      );
      for (const group of new Set(peers.map((peer) => peer.group))) {
        if (group === undefined) continue;
        while (await groupHasLiveMembers(group, cancellation.signal))
          await new Promise((resolvePause) => setTimeout(resolvePause, 10));
      }
      released = true;
    } finally {
      clearTimeout(deadline);
      if (released) cleanupHostProfile(profile);
      else
        console.error(
          JSON.stringify({
            retainedProfile: profile.root,
            reason: "native guardian fixture ownership remains uncertain",
          }),
        );
    }
    if (cancellation.signal.aborted) throw cancellation.signal.reason;
  });
  await /** @type {Promise<void>} */ (
    new Promise((resolveListening, reject) => {
      server.once("error", reject).listen(0, "127.0.0.1", resolveListening);
    })
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { profile, peers, token, port: address.port };
}

/** @param {Peer[]} peers @param {AbortSignal} signal */
async function joinedPeers(peers, signal) {
  const cancel = () => {
    for (const peer of peers) peer.socket.destroy();
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    await Promise.all(peers.map((peer) => peer.closed));
    if (signal.aborted)
      throw new Error("guardian lifetime observation cancelled");
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

const payloadProgram = `
const {spawn,execFileSync}=require('node:child_process');
const {connect}=require('node:net');
const configuration=JSON.parse(process.env.SALTBOX_GUARDIAN_LIFETIME);
if(process.env.SALTBOX_GUARDIAN_ROLE!=='descendant')spawn(process.execPath,['-e',process.env.SALTBOX_GUARDIAN_PAYLOAD],{stdio:'ignore',env:{...process.env,SALTBOX_GUARDIAN_ROLE:'descendant'}});
const group=Number(execFileSync('/bin/ps',['-p',String(process.pid),'-o','pgid=']).toString().trim());
const socket=connect({host:'127.0.0.1',port:configuration.port},()=>socket.write(JSON.stringify({token:configuration.token,pid:process.pid,group})+'\\n'));
let buffer='';
socket.on('data',data=>{buffer+=data;const newline=buffer.indexOf('\\n');if(newline<0)return;const control=JSON.parse(buffer.slice(0,newline));if(control.token===configuration.token&&control.stop===true)process.kill(0,'SIGKILL');});
socket.on('close',()=>process.kill(0,'SIGKILL'));
socket.on('error',()=>process.kill(0,'SIGKILL'));
`;
// Both real native payloads execute this complete fixture; no repository source
// is extracted or evaluated. Passing it through env keeps control nonces out of argv.

test(
  "a crashed owner cannot leave its nested POSIX payload or descendants alive",
  { timeout: 15000 },
  async (t) => {
    if (process.platform === "win32") return;
    const owner = await lifetime(t, 2);
    const parent = `
import {watch} from 'node:fs';
import {ownedCommand} from './scripts/owned-command.mjs';
const observer=watch(process.env.SALTBOX_GUARDIAN_ROOT,(_event,name)=>{if(name==='ready'){observer.close();process.kill(process.pid,'SIGKILL');}});
await ownedCommand(process.execPath,['-e',process.env.SALTBOX_GUARDIAN_PAYLOAD],{phase:'nested guarded payload',timeoutMs:30000});
`;
    await assert.rejects(
      ownedCommand(process.execPath, ["--input-type=module", "-e", parent], {
        phase: "crashed nested command owner",
        timeoutMs: 10000,
        env: {
          ...process.env,
          SALTBOX_GUARDIAN_ROOT: owner.profile.root,
          SALTBOX_GUARDIAN_PAYLOAD: payloadProgram,
          SALTBOX_GUARDIAN_LIFETIME: JSON.stringify({
            port: owner.port,
            token: owner.token,
          }),
        },
      }),
      (error) => error instanceof Error && /SIGKILL/.test(error.message),
    );
    assert.equal(owner.peers.length, 2);
    await joinedPeers(owner.peers, t.signal);
    for (const peer of owner.peers) {
      assert.ok(peer.group);
      assert.equal(await groupHasLiveMembers(peer.group), false);
    }
  },
);

test(
  "parent death during guardian readiness cannot admit a payload",
  { timeout: 15000 },
  async (t) => {
    if (process.platform === "win32") return;
    const owner = await lifetime(t, 1);
    const bootstrap = fileURLToPath(
      new URL("testdata/owned-guardian-bootstrap.mjs", import.meta.url),
    );
    const marker = join(owner.profile.root, "payload-admitted");
    const parent = `
import {watch} from 'node:fs';
import {ownedCommand} from './scripts/owned-command.mjs';
const observer=watch(process.env.SALTBOX_GUARDIAN_ROOT,(_event,name)=>{if(name==='ready'){observer.close();process.kill(process.pid,'SIGKILL');}});
await ownedCommand(process.execPath,['-e','require("node:fs").writeFileSync(process.env.SALTBOX_GUARDIAN_MARKER,"unexpected")'],{phase:'blocked guardian bootstrap',timeoutMs:30000},{guardianPath:process.env.SALTBOX_GUARDIAN_BOOTSTRAP});
`;
    await assert.rejects(
      ownedCommand(process.execPath, ["--input-type=module", "-e", parent], {
        phase: "bootstrap owner crash",
        timeoutMs: 10000,
        env: {
          ...process.env,
          SALTBOX_GUARDIAN_ROOT: owner.profile.root,
          SALTBOX_GUARDIAN_MARKER: marker,
          SALTBOX_GUARDIAN_BOOTSTRAP: bootstrap,
          SALTBOX_GUARDIAN_BOOTSTRAP_CONTROL: JSON.stringify({
            port: owner.port,
            token: owner.token,
          }),
        },
      }),
      (error) => error instanceof Error && /SIGKILL/.test(error.message),
    );
    await joinedPeers(owner.peers, t.signal);
    assert.equal(existsSync(marker), false);
    assert.equal(owner.peers.length, 1);
    assert.ok(owner.peers[0].group);
    assert.equal(await groupHasLiveMembers(owner.peers[0].group), false);
  },
);

test("guardian payload preserves exact argv, ignored stdin EOF and signal status", async () => {
  const args = ["space value", "line\nvalue", "😀"];
  const program =
    "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify(process.argv.slice(1))))";
  assert.equal(
    await ownedCommand(process.execPath, ["-e", program, ...args], {
      phase: "guardian argv and stdin",
      timeoutMs: 10000,
    }),
    JSON.stringify(args),
  );
  await assert.rejects(
    ownedCommand(
      process.execPath,
      ["-e", "process.kill(process.pid,'SIGTERM')"],
      { phase: "guardian payload signal", timeoutMs: 10000 },
    ),
    process.platform === "win32" ? /exited/ : /exited SIGTERM/,
  );
});

for (const mode of ["callback", "throw", "disconnect"]) {
  test(`guardian joins after ${mode} control-write failure before payload admission`, async (t) => {
    if (process.platform === "win32") return;
    const profile = createHostProfile({
      workspaceBase: process.env.SALTBOX_TEST_WORKSPACE_BASE,
    });
    /** @type {import('node:child_process').ChildProcess | undefined} */
    let nativeOwner;
    let commandReleaseProven = false;
    t.after(async () => {
      let released = false;
      const cancellation = new AbortController();
      const deadline = setTimeout(
        () =>
          cancellation.abort(
            new Error("pre-admission fixture cleanup exceeded 5000ms"),
          ),
        5000,
      );
      try {
        if (nativeOwner?.pid) {
          while (
            await groupHasLiveMembers(nativeOwner.pid, cancellation.signal)
          )
            await new Promise((resolvePause) => setTimeout(resolvePause, 10));
          assert.ok(
            nativeOwner.exitCode !== null || nativeOwner.signalCode !== null,
            "the actual native guardian has not exited",
          );
          assert.ok(!nativeOwner.stdout || nativeOwner.stdout.closed);
          assert.ok(!nativeOwner.stderr || nativeOwner.stderr.closed);
          assert.equal(nativeOwner.connected, false);
        } else
          assert.ok(
            commandReleaseProven,
            "no receipt establishes native guardian release",
          );
        released = true;
      } finally {
        clearTimeout(deadline);
        if (released) cleanupHostProfile(profile);
        else
          console.error(
            JSON.stringify({
              retainedProfile: profile.root,
              reason: "pre-admission guardian ownership remains uncertain",
            }),
          );
      }
      if (cancellation.signal.aborted) throw cancellation.signal.reason;
    });
    const marker = join(profile.root, "payload-admitted");
    const failure = new Error("controlled IPC write failure");
    await assert.rejects(
      ownedCommand(
        process.execPath,
        [
          "-e",
          'require("node:fs").writeFileSync(process.env.SALTBOX_GUARDIAN_MARKER,"unexpected")',
        ],
        {
          phase: `${mode} guardian control`,
          timeoutMs: 10000,
          env: { ...process.env, SALTBOX_GUARDIAN_MARKER: marker },
        },
        {
          sendMessage(child, message, completed) {
            nativeOwner = child;
            if ("type" in message && message.type === "start") {
              if (mode === "throw") throw failure;
              if (mode === "callback") {
                queueMicrotask(() => completed(failure));
                return;
              }
              child.disconnect();
            }
            child.send(message, completed);
          },
        },
      ),
      (error) => {
        assert.ok(error instanceof Error && "ownershipReleased" in error);
        commandReleaseProven = error.ownershipReleased === true;
        assert.equal(error.ownershipReleased, true);
        assert.match(error.message, /guardian control write failed/);
        if (mode !== "disconnect") assert.equal(error.cause, failure);
        else {
          assert.ok(error.cause instanceof Error && "code" in error.cause);
          assert.equal(error.cause.code, "ERR_IPC_CHANNEL_CLOSED");
        }
        return true;
      },
    );
    assert.equal(existsSync(marker), false);
  });
}

test("native guardian closure still waits for admitted control-write callback settlement", async () => {
  if (process.platform === "win32") return;
  /** @type {(() => void) | undefined} */
  let releaseWrite;
  /** @type {(() => void) | undefined} */
  let observed;
  const delivered = new Promise((resolveDelivered) => {
    observed = () => resolveDelivered(undefined);
  });
  /** @type {Promise<unknown> | undefined} */
  let closed;
  let settled = false;
  const result = ownedCommand(
    process.execPath,
    ["-e", 'process.stdout.write("owned")'],
    { phase: "delayed IPC completion", timeoutMs: 10000 },
    {
      sendMessage(child, message, completed) {
        if ("type" in message && message.type === "start")
          closed = new Promise((resolveClosed) =>
            child.once("close", resolveClosed),
          );
        child.send(message, (error) => {
          if ("type" in message && message.type === "stop") {
            releaseWrite = () => completed(error);
            observed?.();
          } else completed(error);
        });
      },
    },
  ).then(
    (value) => {
      settled = true;
      return value;
    },
    (error) => {
      settled = true;
      throw error;
    },
  );
  try {
    await delivered;
    assert.ok(closed);
    await closed;
    assert.equal(
      settled,
      false,
      "a native close does not settle an admitted API callback",
    );
    assert.ok(releaseWrite);
    releaseWrite();
    assert.equal(await result, "owned");
  } finally {
    releaseWrite?.();
    await result;
  }
});
