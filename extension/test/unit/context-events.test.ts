import assert from "node:assert/strict";
import { test } from "node:test";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ContextFileSystem } from "../../src/editor.ts";
import type { ProcessRequest } from "../../src/process.ts";
import type { AnalysisRecord } from "../../src/protocol.ts";
import { hash } from "../../src/protocol.ts";
import {
  deferred,
  withNavigationFixture,
  type NavigationFixture,
} from "../support/navigation-fixture.ts";
import { fileClock, settleFiles } from "../support/file-clock.ts";

// Context events reach the editor through its public save and watcher entry
// points. Each instance owns its scripted backend, timers and context reader.
// The source analysis reads the target declaration, so the source result
// depends on a file below roles/target, which the nested cases also open as
// its own workspace folder.
async function wire(
  request: ProcessRequest,
  f: NavigationFixture,
  peer?: string,
): Promise<string> {
  if (request.args[0] === "--version") return "fixture backend\n";
  if (request.args[0] === "rules")
    return JSON.stringify({ schema_version: 1, rules: [] });
  assert.equal(request.args[0], "check");
  const root = request.args[request.args.indexOf("--root") + 1];
  const slash = (filename: string) =>
    relative(root, filename).replaceAll("\\", "/");
  const inside = (path: string) =>
    path !== ".." && !path.startsWith("../") && !path.startsWith("/");
  const source = slash(f.source),
    target = slash(f.target),
    other = peer === undefined ? undefined : slash(peer);
  const selected =
    request.input !== undefined
      ? [slash(request.args[request.args.indexOf("--stdin-filename") + 1])]
      : request.args.slice(request.args.indexOf("--") + 1);
  const paths = selected.includes(".")
    ? [source, target, ...(other === undefined ? [] : [other])].filter(inside)
    : selected;
  const targetBytes = await readFile(f.target);
  const sources: AnalysisRecord["sources"] = [];
  for (const path of paths) {
    const bytes =
      request.input !== undefined
        ? Buffer.from(request.input)
        : await readFile(join(root, ...path.split("/")));
    sources.push({
      path,
      source_sha256: hash(bytes),
      files: [
        { path, sha256: hash(bytes), state: "read" },
        ...(path === source || (path === other && root === f.root)
          ? [
              {
                path: target,
                sha256: hash(targetBytes),
                state: "read" as const,
              },
            ]
          : []),
      ],
      identity: [],
      discovery: [],
      directories: [],
    });
  }
  return JSON.stringify({
    schema_version: 2,
    diagnostics: [],
    fixes: [],
    analysis: {
      schema_version: 1,
      root,
      generation: hash("generation"),
      complete: true,
      sources,
    },
  });
}

const operations = { acceptedOperations: ["check", "--version", "rules"] };
const checks = (
  requests: readonly ProcessRequest[],
  root: string,
  filename: string,
) =>
  requests.filter(
    (request) =>
      request.args[0] === "check" &&
      request.args[request.args.indexOf("--root") + 1] === root &&
      (request.args.includes(filename) ||
        request.args.includes(relative(root, filename).replaceAll("\\", "/"))),
  ).length;

/** Writes the open target buffer to disk and delivers the editor's save. */
async function save(f: NavigationFixture, text: string): Promise<void> {
  f.targetDocument.edit(text);
  await writeFile(f.target, text);
  f.targetDocument.isDirty = false;
  f.editor.saved(f.targetDocument.asDocument());
}

/** A context reader whose reads of one file can be held by the test. */
function heldReads(filename: () => string) {
  const holds: {
    entered: ReturnType<typeof deferred<void>>;
    released: ReturnType<typeof deferred<void>>;
  }[] = [];
  const reads: string[] = [];
  const files: Partial<ContextFileSystem> = {
    readFile: async (path) => {
      const bytes = await readFile(path);
      reads.push(hash(bytes));
      const hold = path === filename() ? holds.shift() : undefined;
      if (hold) {
        hold.entered.resolve();
        await hold.released.promise;
      }
      return bytes;
    },
  };
  return {
    files,
    reads,
    /** Holds the next read of the file until release is called. */
    hold() {
      const hold = { entered: deferred<void>(), released: deferred<void>() };
      holds.push(hold);
      return {
        entered: hold.entered.promise,
        release: () => hold.released.resolve(),
      };
    },
  };
}

for (const marked of [false, true]) {
  test(
    `a ${marked ? "marked" : "unmarked"} nested workspace folder still invalidates the enclosing root's dependency results`,
    { timeout: 30000 },
    async () => {
      const timer = fileClock();
      const requests: ProcessRequest[] = [];
      let fixture!: NavigationFixture;
      await withNavigationFixture(
        {
          schedule: timer.schedule,
          runProcess: async (request) => {
            requests.push(request);
            return wire(request, fixture);
          },
        },
        async (f) => {
          fixture = f;
          const nested = join(f.root, "roles", "target");
          if (marked) await writeFile(join(nested, ".saltbox-lint"), "");
          f.setWorkspaceFolders([f.root, nested]);
          await f.editor.ready();
          await settleFiles(f.editor, timer);
          const source = f.document.asDocument();
          await f.editor.check(source, true);
          await settleFiles(f.editor, timer);
          assert.equal(f.editor.status(source).state, "current");
          const sourceBefore = checks(requests, f.root, f.source);
          const ownerBefore = checks(requests, nested, f.target);
          const parentTargetBefore = checks(requests, f.root, f.target);
          await save(f, "target_role_port: 43\n");
          await f.editor.settleContext();
          assert.equal(
            f.editor.status(source).state,
            "stale",
            "the enclosing root's result depends on the nested file",
          );
          await settleFiles(f.editor, timer);
          assert.equal(
            checks(requests, f.root, f.source),
            sourceBefore + 1,
            "the enclosing root rechecks its dependent source once",
          );
          assert.equal(f.editor.status(source).state, "current");
          assert.equal(
            checks(requests, f.root, f.target),
            parentTargetBefore,
            "the enclosing root never checks a file owned by the nested folder",
          );
          assert.equal(
            checks(requests, nested, f.target),
            ownerBefore + (marked ? 1 : 0),
            "only a marked owner checks its own saved file, exactly once",
          );
          // A watcher echo of the same bytes reaches both roots and coalesces.
          const settled = requests.length;
          f.editor.removeFile(f.targetDocument.uri);
          await f.editor.settleContext();
          await settleFiles(f.editor, timer);
          assert.equal(requests.length, settled, "echoes must coalesce");
          assert.equal(f.editor.status(source).state, "current");
        },
        operations,
      );
    },
  );
}

test(
  "an enclosing root dependency event leaves a marked nested owner's peer alone",
  { timeout: 30000 },
  async () => {
    const timer = fileClock();
    const requests: ProcessRequest[] = [];
    let fixture!: NavigationFixture;
    let peer!: string;
    await withNavigationFixture(
      {
        schedule: timer.schedule,
        runProcess: async (request) => {
          requests.push(request);
          return wire(request, fixture, peer);
        },
      },
      async (f) => {
        fixture = f;
        const nested = join(f.root, "roles", "target");
        // A closed peer owned by the nested root. Only the enclosing root's
        // analysis of the peer reads the target declaration.
        peer = join(nested, "tasks", "main.yml");
        await mkdir(join(peer, ".."), { recursive: true });
        await writeFile(peer, "- debug: {}\n");
        await writeFile(join(nested, ".saltbox-lint"), "");
        f.setWorkspaceFolders([f.root, nested]);
        await f.editor.ready();
        await settleFiles(f.editor, timer);
        await f.editor.check(f.document.asDocument(), true);
        await f.editor.checkWorkspace();
        await settleFiles(f.editor, timer);
        assert.ok(
          requests.some(
            (request) =>
              request.args[request.args.indexOf("--root") + 1] === f.root &&
              request.args.at(-1) === ".",
          ),
          "the enclosing root's coverage records the nested peer",
        );
        const peerChecks = () =>
          checks(requests, nested, peer) + checks(requests, f.root, peer);
        const before = {
          source: checks(requests, f.root, f.source),
          owner: checks(requests, nested, f.target),
          peer: peerChecks(),
        };
        await save(f, "target_role_port: 43\n");
        await f.editor.settleContext();
        await settleFiles(f.editor, timer);
        assert.equal(checks(requests, f.root, f.source), before.source + 1);
        assert.equal(checks(requests, nested, f.target), before.owner + 1);
        assert.equal(
          peerChecks(),
          before.peer,
          "the nested owner's peer is not re-queued by the enclosing root",
        );
        assert.equal(f.editor.status(f.document.asDocument()).state, "current");
      },
      operations,
    );
  },
);

test(
  "rapid context events complete in order and the last observation wins",
  { timeout: 30000 },
  async () => {
    const timer = fileClock();
    const requests: ProcessRequest[] = [];
    let fixture!: NavigationFixture;
    const reader = heldReads(() => fixture.target);
    await withNavigationFixture(
      {
        schedule: timer.schedule,
        contextFiles: reader.files,
        runProcess: async (request) => {
          requests.push(request);
          return wire(request, fixture);
        },
      },
      async (f) => {
        fixture = f;
        const source = f.document.asDocument();
        await settleFiles(f.editor, timer);
        await f.editor.check(source, true);
        await settleFiles(f.editor, timer);
        assert.equal(f.editor.status(source).state, "current");
        const first = reader.hold();
        await writeFile(f.target, "target_role_port: 43\n");
        f.editor.removeFile(f.targetDocument.uri);
        await first.entered;
        const readsWhileHeld = reader.reads.length;
        await writeFile(f.target, "target_role_port: 44\n");
        f.editor.removeFile(f.targetDocument.uri);
        for (let turn = 0; turn < 20; turn++)
          await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
          reader.reads.length,
          readsWhileHeld,
          "a later event cannot be observed before the earlier one completes",
        );
        assert.equal(
          f.editor.status(source).state,
          "current",
          "a pending observation does not stale results by itself",
        );
        first.release();
        await f.editor.settleContext();
        assert.deepEqual(
          reader.reads.slice(-2),
          [hash("target_role_port: 43\n"), hash("target_role_port: 44\n")],
          "the later event observes the file only after the earlier one completes",
        );
        assert.equal(f.editor.status(source).state, "stale");
        await settleFiles(f.editor, timer);
        assert.equal(f.editor.status(source).state, "current");
        const settled = requests.length;
        f.editor.removeFile(f.targetDocument.uri);
        await f.editor.settleContext();
        await settleFiles(f.editor, timer);
        assert.equal(
          requests.length,
          settled,
          "the final fingerprint is the latest bytes, so a later echo coalesces",
        );
      },
      operations,
    );
  },
);

for (const outcome of ["changed", "echo"] as const) {
  test(
    `a pending context fence holds an in-flight result until a ${outcome} observation completes`,
    { timeout: 30000 },
    async () => {
      const timer = fileClock();
      const requests: ProcessRequest[] = [];
      let fixture!: NavigationFixture;
      const reader = heldReads(() => fixture.target);
      const backend = deferred<void>();
      let holdBackend = false;
      await withNavigationFixture(
        {
          schedule: timer.schedule,
          contextFiles: reader.files,
          runProcess: async (request) => {
            requests.push(request);
            // Capture dependency bytes before the context change.
            const result = await wire(request, fixture);
            if (holdBackend && request.input !== undefined) {
              holdBackend = false;
              await backend.promise;
            }
            return result;
          },
        },
        async (f) => {
          fixture = f;
          const source = f.document.asDocument();
          await settleFiles(f.editor, timer);
          await f.editor.check(source, true);
          await settleFiles(f.editor, timer);
          const before = checks(requests, f.root, f.source);
          const writes = f.diagnosticWrites.length;
          holdBackend = true;
          const pending = f.editor.check(source, true);
          while (checks(requests, f.root, f.source) === before)
            await new Promise<void>((resolve) => setImmediate(resolve));
          const observation = reader.hold();
          if (outcome === "changed")
            await writeFile(f.target, "target_role_port: 43\n");
          f.editor.removeFile(f.targetDocument.uri);
          await observation.entered;
          let completed = false;
          const joined = pending.then(() => {
            completed = true;
          });
          try {
            backend.resolve();
            for (let turn = 0; turn < 50; turn++)
              await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(
              completed,
              false,
              "the in-flight result waits for the pending observation",
            );
            assert.equal(
              f.diagnosticWrites.length,
              writes,
              "nothing is published while the fence is pending",
            );
          } finally {
            observation.release();
          }
          await joined;
          await settleFiles(f.editor, timer);
          assert.equal(
            checks(requests, f.root, f.source),
            before + (outcome === "changed" ? 2 : 1),
            outcome === "changed"
              ? "the result that read old dependency bytes is rejected and retried"
              : "an unchanged observation accepts the held result without a retry",
          );
          assert.equal(f.editor.status(source).state, "current");
        },
        operations,
      );
    },
  );
}

test(
  "disposal joins a pending context observation and admits no follow-up work",
  { timeout: 30000 },
  async () => {
    const timer = fileClock();
    const requests: ProcessRequest[] = [];
    let fixture!: NavigationFixture;
    const reader = heldReads(() => fixture.target);
    await withNavigationFixture(
      {
        schedule: timer.schedule,
        contextFiles: reader.files,
        runProcess: async (request) => {
          requests.push(request);
          return wire(request, fixture);
        },
      },
      async (f) => {
        fixture = f;
        const source = f.document.asDocument();
        await settleFiles(f.editor, timer);
        await f.editor.check(source, true);
        await settleFiles(f.editor, timer);
        const observation = reader.hold();
        await writeFile(f.target, "target_role_port: 43\n");
        f.editor.removeFile(f.targetDocument.uri);
        await observation.entered;
        const settled = requests.length;
        f.editor.dispose();
        let joined = false;
        const join = f.editor.join().then(() => {
          joined = true;
        });
        try {
          for (let turn = 0; turn < 20; turn++)
            await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(joined, false, "join owns the admitted observation");
        } finally {
          observation.release();
        }
        await join;
        assert.equal(timer.deliver(), 0, "no follow-up timer was admitted");
        assert.equal(requests.length, settled);
      },
      operations,
    );
  },
);

test(
  "an unavailable context observation invalidates dependents without reporting an error",
  { timeout: 30000 },
  async () => {
    const timer = fileClock();
    const requests: ProcessRequest[] = [];
    let fixture!: NavigationFixture;
    let failures = 0;
    await withNavigationFixture(
      {
        schedule: timer.schedule,
        contextFiles: {
          lstat: async (path, options) => {
            if (path === fixture.target && failures > 0) {
              failures--;
              throw Object.assign(new Error("EACCES: fixture"), {
                code: "EACCES",
              });
            }
            return lstat(path, options);
          },
        },
        runProcess: async (request) => {
          requests.push(request);
          return wire(request, fixture);
        },
      },
      async (f) => {
        fixture = f;
        const source = f.document.asDocument();
        await settleFiles(f.editor, timer);
        await f.editor.check(source, true);
        await settleFiles(f.editor, timer);
        const before = checks(requests, f.root, f.source);
        failures = 1;
        f.editor.removeFile(f.targetDocument.uri);
        await f.editor.settleContext();
        assert.equal(failures, 0);
        assert.equal(f.editor.status(source).state, "stale");
        await settleFiles(f.editor, timer);
        assert.equal(checks(requests, f.root, f.source), before + 1);
        assert.equal(f.editor.status(source).state, "current");
        assert.deepEqual(f.notices, []);
        assert.ok(!f.lines.some((line) => line.includes("EACCES")));
      },
      operations,
    );
  },
);
