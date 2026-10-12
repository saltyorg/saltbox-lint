// @ts-check
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { groupHasLiveMembers } from "./owned-group.mjs";

/**
 * @typedef {{reservations: number, registrations: number, groups: number, released: true}} OwnershipRelease
 * @typedef {{environment: string, finish: () => Promise<OwnershipRelease>, events: EventEmitter, readonly registrationCount: number, readonly reservationCount: number}} HostProcessSupervisor
 * @typedef {{platform?: NodeJS.Platform, observeGroup?: (group: number, signal: AbortSignal) => Promise<boolean>, cleanupTimeoutMs?: number, handshakeTimeoutMs?: number}} SupervisorOptions
 * @typedef {{state: 'reserved' | 'bound' | 'joined' | 'cancelled', nonce: string, owner: import('node:net').Socket, ownerClosed: boolean, guard: import('node:net').Socket | undefined, guardClosed: boolean, group: number | undefined}} Reservation
 * @typedef {{role: 'owner' | 'guard' | 'declined' | undefined, reservation: Reservation | undefined, buffer: string, closed: () => void, joined: Promise<void>}} Peer
 */

/** @param {number} milliseconds @param {AbortSignal} signal @returns {Promise<void>} */
function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** @param {unknown} value @returns {value is string} */
function nonce(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
/** @param {Record<string, unknown>} message @param {readonly string[]} names */
function fields(message, names) {
  assert.ok(message && typeof message === "object" && !Array.isArray(message));
  assert.deepEqual(Object.keys(message).sort(), [...names].sort());
}

// The editor reserves before spawn; the native group binds that reservation
// before work. Credentialed live channels control groups; numeric IDs only
// support read-only disappearance checks, including pre-bind child completion.
/** @param {SupervisorOptions} [options] @returns {Promise<HostProcessSupervisor | undefined>} */
export async function createHostProcessSupervisor({
  platform = process.platform,
  observeGroup = groupHasLiveMembers,
  cleanupTimeoutMs = 12000,
  handshakeTimeoutMs = 5000,
} = {}) {
  if (platform === "win32") return undefined;
  assert.ok(
    ["linux", "darwin"].includes(platform),
    "host process supervisor requires a supported native platform",
  );
  const token = randomBytes(32).toString("hex");
  const events = new EventEmitter();
  /** @type {Map<import('node:net').Socket, Peer>} */
  const sockets = new Map();
  /** @type {Map<string, Reservation>} */
  const reservations = new Map();
  /** @type {Set<number>} */
  const groups = new Set();
  /** @type {Error[]} */
  const failures = [];
  let registrations = 0;
  let sealed = false;
  /** @type {Promise<OwnershipRelease> | undefined} */
  let finishPromise;
  /** @param {string} message */
  const fail = (message) => failures.push(new Error(message));
  /** @param {import('node:net').Socket} socket @param {object} message @param {() => void} [notify] */
  const acknowledge = (socket, message, notify) =>
    socket.write(JSON.stringify(message) + "\n", (error) => {
      if (error) socket.destroy();
      else notify?.();
    });
  const server = createServer((socket) => {
    /** @type {() => void} */
    let resolveClosed = () => {};
    /** @type {Promise<void>} */
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    /** @type {Peer} */
    const peer = {
      role: undefined,
      reservation: undefined,
      buffer: "",
      closed: resolveClosed,
      joined: closed,
    };
    sockets.set(socket, peer);
    const handshake = setTimeout(() => {
      fail("nested process registration did not complete before its deadline");
      socket.destroy();
    }, handshakeTimeoutMs);
    socket.setNoDelay(true).setEncoding("utf8");
    socket.on("error", () => {
      // A peer can cancel before sending any complete header, hence before it
      // could receive reserve ACK and create a detached child. Reservation
      // state, rather than this connection's existence, determines uncertainty.
      socket.destroy();
    });
    socket.once("close", () => {
      clearTimeout(handshake);
      peer.closed();
      if (peer.role === "owner" && peer.reservation)
        peer.reservation.ownerClosed = true;
      if (peer.role === "guard" && peer.reservation)
        peer.reservation.guardClosed = true;
    });
    /** @param {unknown} value */
    const receiveValue = (value) => {
      assert.ok(value && typeof value === "object" && !Array.isArray(value));
      receive(/** @type {Record<string, unknown>} */ (value));
    };
    /** @param {Record<string, unknown>} message */
    const receive = (message) => {
      if (!peer.role) {
        assert.equal(sealed, false);
        assert.equal(message.token, token);
        assert.ok(nonce(message.nonce));
        if (message.type === "reserve") {
          fields(message, ["token", "type", "nonce"]);
          assert.equal(reservations.has(message.nonce), false);
          /** @type {Reservation} */
          const reservation = {
            state: "reserved",
            nonce: message.nonce,
            owner: socket,
            ownerClosed: false,
            guard: undefined,
            guardClosed: false,
            group: undefined,
          };
          // Account the admission before ACK so death between ACK and spawn
          // cannot turn an unknown detached startup into a clean result.
          reservations.set(message.nonce, reservation);
          peer.role = "owner";
          peer.reservation = reservation;
          clearTimeout(handshake);
          acknowledge(socket, { reserved: true });
          events.emit("reserved");
        } else {
          assert.equal(message.type, "bind");
          fields(message, ["token", "type", "nonce", "pid", "group"]);
          assert.ok(
            typeof message.pid === "number" &&
              Number.isSafeInteger(message.pid) &&
              message.pid > 1,
          );
          assert.equal(message.group, message.pid);
          const reservation = reservations.get(message.nonce);
          assert.ok(reservation);
          if (
            reservation.state === "joined" &&
            reservation.group === message.pid
          ) {
            // The joined-child report and buffered native bind travel on
            // different streams. Decline this already-finished child without
            // turning valid bootstrap cancellation into a protocol failure.
            clearTimeout(handshake);
            peer.role = "declined";
            acknowledge(socket, { accepted: false });
            socket.end();
            return;
          }
          assert.equal(reservation.state, "reserved");
          reservation.state = "bound";
          reservation.group = message.pid;
          reservation.guard = socket;
          groups.add(message.pid);
          registrations++;
          peer.role = "guard";
          peer.reservation = reservation;
          clearTimeout(handshake);
          acknowledge(socket, { accepted: true }, () =>
            events.emit("registered", { group: message.group }),
          );
        }
        return;
      }
      assert.equal(peer.role, "owner");
      const reservation = peer.reservation;
      assert.ok(reservation);
      if (message.cancel === true) {
        fields(message, ["cancel"]);
        assert.equal(reservation.state, "reserved");
        reservation.state = "cancelled";
      } else {
        fields(message, ["joined", "pid"]);
        assert.equal(message.joined, true);
        assert.ok(
          typeof message.pid === "number" &&
            Number.isSafeInteger(message.pid) &&
            message.pid > 1,
        );
        assert.ok(["reserved", "bound"].includes(reservation.state));
        if (reservation.group !== undefined)
          assert.equal(reservation.group, message.pid);
        reservation.group = message.pid;
        reservation.state = "joined";
        groups.add(message.pid);
      }
      acknowledge(socket, { completed: true });
      socket.end();
    };
    socket.on("data", (data) => {
      peer.buffer += data;
      if (peer.buffer.length > 2048) {
        fail("nested process ownership message exceeded its size bound");
        socket.destroy();
        return;
      }
      let newline;
      while ((newline = peer.buffer.indexOf("\n")) >= 0) {
        const line = peer.buffer.slice(0, newline);
        peer.buffer = peer.buffer.slice(newline + 1);
        try {
          receiveValue(JSON.parse(line));
        } catch {
          fail("nested process ownership message was rejected");
          socket.destroy();
          return;
        }
      }
    });
  });
  await /** @type {Promise<void>} */ (
    new Promise((resolve, reject) => {
      /** @param {Error} failure */
      const error = (failure) => {
        server.close();
        reject(failure);
      };
      server.once("error", error);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", error);
        resolve();
      });
    })
  );
  server.on("error", () => fail("nested process ownership server failed"));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const finish = () =>
    (finishPromise ??= (async () => {
      sealed = true;
      const cancellation = new AbortController();
      const deadline = setTimeout(() => {
        cancellation.abort(
          new Error(`nested process cleanup exceeded ${cleanupTimeoutMs}ms`),
        );
        for (const socket of sockets.keys()) socket.destroy();
      }, cleanupTimeoutMs);
      const closed = new Promise((resolve) => server.close(resolve));
      /** @type {Promise<void>[]} */
      let probes = [];
      try {
        for (const [socket, peer] of sockets) {
          if (peer.role === "guard" && !socket.destroyed) {
            socket.write(JSON.stringify({ stop: true }) + "\n", (error) => {
              if (error) socket.destroy();
            });
          } else socket.destroy();
        }
        await closed;
        await Promise.all([...sockets.values()].map((peer) => peer.joined));
        if (cancellation.signal.aborted) throw cancellation.signal.reason;
        const unbound = [...reservations.values()].filter(
          (reservation) => reservation.state === "reserved",
        );
        if (unbound.length)
          fail(`${unbound.length} pre-spawn reservation(s) remain unresolved`);
        const observedGroups = [...groups];
        let next = 0;
        probes = Array.from(
          { length: Math.min(8, observedGroups.length) },
          async () => {
            while (next < observedGroups.length) {
              const group = observedGroups[next++];
              while (await observeGroup(group, cancellation.signal))
                await delay(25, cancellation.signal);
            }
          },
        );
        await Promise.all(probes);
        if (failures.length)
          throw new AggregateError(failures, "nested process ownership failed");
        return {
          reservations: reservations.size,
          registrations,
          groups: groups.size,
          released: true,
        };
      } finally {
        clearTimeout(deadline);
        cancellation.abort(new Error("nested process owner finished"));
        await Promise.allSettled(probes);
        for (const socket of sockets.keys()) socket.destroy();
        await closed;
        await Promise.all([...sockets.values()].map((peer) => peer.joined));
        events.removeAllListeners();
      }
    })());
  return {
    environment: JSON.stringify({
      address: `127.0.0.1:${address.port}`,
      token,
    }),
    finish,
    events,
    get registrationCount() {
      return registrations;
    },
    get reservationCount() {
      return reservations.size;
    },
  };
}
