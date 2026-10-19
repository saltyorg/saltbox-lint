import assert from "node:assert/strict";
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { test } from "node:test";
import type * as vscode from "vscode";
import { hash, parseFormat } from "../../src/protocol.ts";
import type { ProcessRequest } from "../../src/process.ts";
import { checkWire } from "../support/check-wire.ts";
import {
  deferred,
  fixtureUri,
  withNavigationFixture,
} from "../support/navigation-fixture.ts";

function formattingWire(request: ProcessRequest): string {
  const text = String(request.input);
  const wire = JSON.stringify({
    schema_version: 1,
    path: relative(
      request.cwd,
      request.args[request.args.indexOf("--stdin-filename") + 1],
    ).replaceAll("\\", "/"),
    source_sha256: hash(text),
    status: "ready",
    edits: [
      {
        range: {
          start: { line: 1, column: 1 },
          end: { line: 1, column: 1 },
        },
        span: { start: 0, end: 0 },
        text: "# formatted\n",
      },
    ],
  });
  parseFormat(
    wire,
    relative(
      request.cwd,
      request.args[request.args.indexOf("--stdin-filename") + 1],
    ).replaceAll("\\", "/"),
    text,
  );
  return wire;
}

for (const workspaceAlias of [false, true]) {
  test(`template dependency deletion reaches ${workspaceAlias ? "aliased" : "native"} workspace resources`, async () => {
    let paths!: { root: string; source: string; target: string };
    const templatePath = "roles/source/templates/router.conf",
      contents = "template: valid\n";
    let templatePresent = true;
    const watchers: {
      base: string;
      pattern: string;
      active: boolean;
      deleted?: (uri: vscode.Uri) => unknown;
    }[] = [];
    await withNavigationFixture(
      {
        schedule: () => () => {},
        roots: {
          createFileSystemWatcher: (pattern) => {
            assert.equal(typeof pattern, "object");
            if (typeof pattern === "string")
              throw new Error("expected a relative watcher");
            const entry: (typeof watchers)[number] = {
              base: pattern.baseUri.fsPath,
              pattern: pattern.pattern,
              active: true,
            };
            watchers.push(entry);
            const subscription = { dispose() {} };
            return {
              ignoreCreateEvents: false,
              ignoreChangeEvents: false,
              ignoreDeleteEvents: false,
              onDidCreate: () => subscription,
              onDidChange: () => subscription,
              onDidDelete: (listener) => {
                entry.deleted = listener;
                return subscription;
              },
              dispose() {
                entry.active = false;
              },
            };
          },
        },
        runProcess: async (request) => {
          const report = JSON.parse(
            await checkWire(request, { ...paths, root: request.cwd }),
          );
          if (request.args[0] === "check")
            for (const source of report.analysis.sources)
              source.files.push(
                templatePresent
                  ? {
                      path: templatePath,
                      state: "read",
                      sha256: hash(contents),
                    }
                  : { path: templatePath, state: "missing" },
              );
          return JSON.stringify(report);
        },
      },
      async (f) => {
        paths = {
          root: await realpath(f.root),
          source: await realpath(f.source),
          target: await realpath(f.target),
        };
        const filename = join(f.root, templatePath);
        await mkdir(join(filename, ".."), { recursive: true });
        await writeFile(filename, contents);
        await f.editor.check(f.document.asDocument(), true);
        assert.equal(f.editor.status(f.document.asDocument()).state, "current");
        await rm(filename);
        templatePresent = false;
        const emitDeletion = (uri: vscode.Uri) => {
          for (const watcher of watchers) {
            if (!watcher.active || watcher.pattern !== "**/templates/**")
              continue;
            const path = relative(watcher.base, uri.fsPath);
            if (
              path === ".." ||
              path.startsWith(`..${sep}`) ||
              isAbsolute(path)
            )
              continue;
            watcher.deleted?.(uri);
          }
        };
        emitDeletion(fixtureUri(filename));
        assert.equal(
          f.editor.status(f.document.asDocument()).state,
          "stale",
          "the SDK's public resource deletion must invalidate the saved template dependency",
        );
        await f.editor.check(f.document.asDocument(), true);
        assert.equal(f.editor.status(f.document.asDocument()).state, "current");
        emitDeletion(fixtureUri(join(paths.root, templatePath)));
        assert.equal(
          f.editor.status(f.document.asDocument()).state,
          "current",
          "a late native echo must preserve the fresh missing-template result",
        );
      },
      { workspaceAlias, acceptedOperations: ["check", "rules"] },
    );
  });

  test(`pending parent formatter declines ${workspaceAlias ? "aliased" : "native"} nested workspace handoff`, async () => {
    let paths!: { root: string; source: string; target: string };
    const entered = deferred<void>(),
      released = deferred<void>();
    await withNavigationFixture(
      {
        schedule: () => () => {},
        runProcess: async (request) => {
          if (request.args[0] !== "format")
            return checkWire(request, { ...paths, root: request.cwd });
          entered.resolve();
          await released.promise;
          return formattingWire(request);
        },
      },
      async (f) => {
        paths = {
          root: await realpath(f.root),
          source: await realpath(f.source),
          target: await realpath(f.target),
        };
        await f.editor.check(f.document.asDocument(), true);
        const nested = join(f.root, "roles/source");
        await writeFile(join(nested, ".saltbox-lint"), "");
        const pending = f.resources.operation(
          "parent formatter crossing workspace handoff",
          () => f.editor.format(f.document.asDocument(), "canonical"),
        );
        try {
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error(
                "formatter settled before controlled response gate",
              );
            }),
          ]);
          f.setWorkspaceFolders([f.root, nested]);
          await f.editor.ready();
          released.resolve();
          assert.equal(
            (await pending).length,
            0,
            "an already marked nested owner must revoke the previous parent formatter",
          );
        } finally {
          released.resolve();
          await Promise.allSettled([pending]);
        }
      },
      { workspaceAlias, acceptedOperations: ["check", "rules", "format"] },
    );
  });

  test(`nested workspace retires parent results through ${workspaceAlias ? "an aliased" : "a native"} workspace path`, async () => {
    let paths!: { root: string; source: string; target: string };
    await withNavigationFixture(
      {
        schedule: () => () => {},
        runProcess: (request) =>
          request.args[0] === "format"
            ? Promise.resolve(formattingWire(request))
            : checkWire(request, { ...paths, root: request.cwd }),
      },
      async (f) => {
        paths = {
          root: await realpath(f.root),
          source: await realpath(f.source),
          target: await realpath(f.target),
        };
        await f.editor.check(f.document.asDocument(), true);
        assert.equal(f.editor.status(f.document.asDocument()).state, "current");
        const nested = join(f.root, "roles/source");
        f.setWorkspaceFolders([f.root, nested]);
        await f.editor.ready();
        assert.equal(
          f.editor.status(f.document.asDocument()).state,
          "missing-marker",
        );
        await writeFile(join(nested, ".saltbox-lint"), "");
        await f.editor.check(
          f.document.asDocument(),
          true,
          undefined,
          false,
          AbortSignal.abort(),
        );
        assert.equal(
          f.editor.status(f.document.asDocument()).state,
          "eligible",
          "enabling a nested marker cannot republish a parent-owned buffer result as current",
        );
        await f.editor.check(f.document.asDocument(), true);
        assert.equal(f.editor.status(f.document.asDocument()).state, "current");
        assert.equal(
          (await f.editor.format(f.document.asDocument(), "canonical")).length,
          1,
        );
        f.setWorkspaceFolders([f.root]);
        await f.editor.ready();
        assert.equal(
          f.editor.status(f.document.asDocument()).state,
          "eligible",
          "removing the nested owner retires its result before restoring the parent",
        );
        await f.editor.check(f.document.asDocument(), true);
        assert.equal(f.editor.status(f.document.asDocument()).state, "current");
        assert.equal(
          (await f.editor.format(f.document.asDocument(), "canonical")).length,
          1,
        );
      },
      { workspaceAlias, acceptedOperations: ["check", "rules", "format"] },
    );
  });
}

for (const changed of [false, true]) {
  test(`formatter joins superseded initial root probes with ${changed ? "an edited" : "the original"} model`, async () => {
    const entered = [deferred<void>(), deferred<void>()];
    const released = [deferred<void>(), deferred<void>()];
    let probes = 0;
    let submitted = 0;
    let markerDeleted: (() => void) | undefined;
    const disposable = { dispose() {} };
    await withNavigationFixture(
      {
        roots: {
          lstat: (async (...args: Parameters<typeof lstat>) => {
            const index = probes++;
            const stat = await lstat(...args);
            if (index < entered.length) {
              entered[index].resolve();
              await released[index].promise;
            }
            return stat;
          }) as typeof lstat,
          createFileSystemWatcher: (pattern) => ({
            ignoreCreateEvents: false,
            ignoreChangeEvents: false,
            ignoreDeleteEvents: false,
            onDidCreate: () => disposable,
            onDidChange: () => disposable,
            onDidDelete: (listener) => {
              if (
                typeof pattern === "object" &&
                pattern.pattern === ".saltbox-lint"
              )
                markerDeleted = () =>
                  listener(
                    fixtureUri(join(pattern.baseUri.fsPath, ".saltbox-lint")),
                  );
              return disposable;
            },
            dispose() {},
          }),
        },
        runProcess: async (request) => {
          submitted++;
          return formattingWire(request);
        },
      },
      async ({ editor, document, resources }) => {
        let ready = false;
        const readiness = resources.operation("current root readiness", () =>
          editor.ready().then(() => {
            ready = true;
          }),
        );
        const formatting = resources.operation("first root formatter", () =>
          editor.format(document.asDocument(), "canonical"),
        );
        let currentReadiness: Promise<void> | undefined;
        try {
          await Promise.race([
            entered[0].promise,
            readiness.then(() => {
              throw new Error(
                "Initial readiness settled before probe admission",
              );
            }),
          ]);
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.ok(
            markerDeleted,
            "the marker watcher has its delete listener",
          );
          markerDeleted();
          assert.equal(probes, 2, "the replacement probe was admitted");
          currentReadiness = resources.operation(
            "replacement root readiness",
            () => editor.ready(),
          );
          await Promise.race([
            entered[1].promise,
            currentReadiness.then(() => {
              throw new Error(
                "Replacement readiness settled before probe admission",
              );
            }),
          ]);
          if (changed) {
            document.edit("# edited while probing\n" + document.getText());
            editor.change(document.asDocument());
          }
          released[0].resolve();
          await new Promise<void>((resolve) => setImmediate(resolve));
          const readyBeforeCurrentProbe = ready;
          assert.equal(
            submitted,
            0,
            "no formatter runs before current readiness",
          );
          released[1].resolve();
          await readiness;
          const edits = await formatting;
          assert.equal(
            edits.length,
            changed ? 0 : 1,
            changed
              ? "an edit during readiness declines the original format request"
              : "the first formatter returns edits after the current probe",
          );
          assert.equal(submitted, changed ? 0 : 1);
          assert.equal(
            readyBeforeCurrentProbe,
            false,
            "the current marker was still pending when the older probe finished",
          );
        } finally {
          for (const gate of released) gate.resolve();
          await Promise.allSettled([readiness, formatting, currentReadiness]);
        }
      },
      { waitForReady: false, acceptedOperations: ["format"] },
    );
  });
}

for (const state of [
  "unchanged",
  "removed",
  "replaced",
  "rewritten",
] as const) {
  test(`formatter handles ${state} marker during a deletion notification`, async () => {
    const entered = deferred<void>();
    const released = deferred<void>();
    let markerDeleted: (() => void) | undefined;
    const disposable = { dispose() {} };
    await withNavigationFixture(
      {
        roots: {
          createFileSystemWatcher: (pattern) => ({
            ignoreCreateEvents: false,
            ignoreChangeEvents: false,
            ignoreDeleteEvents: false,
            onDidCreate: () => disposable,
            onDidChange: () => disposable,
            onDidDelete: (listener) => {
              if (
                typeof pattern === "object" &&
                pattern.pattern === ".saltbox-lint"
              )
                markerDeleted = () =>
                  listener(
                    fixtureUri(join(pattern.baseUri.fsPath, ".saltbox-lint")),
                  );
              return disposable;
            },
            dispose() {},
          }),
        },
        runProcess: async (request) => {
          entered.resolve();
          await released.promise;
          return formattingWire(request);
        },
      },
      async ({ editor, document, resources, root }) => {
        const before = await lstat(join(root, ".saltbox-lint"), {
          bigint: true,
        });
        const formatting = resources.operation(
          "format across stale marker event",
          () => editor.format(document.asDocument(), "canonical"),
        );
        try {
          await Promise.race([
            entered.promise,
            formatting.then(() => {
              throw new Error("formatter settled before CLI admission");
            }),
          ]);
          assert.ok(markerDeleted);
          const marker = join(root, ".saltbox-lint");
          if (state === "removed" || state === "replaced") await rm(marker);
          if (state === "replaced" || state === "rewritten")
            await writeFile(marker, "{}\n");
          markerDeleted();
          released.resolve();
          const edits = await formatting;
          if (state === "removed")
            await assert.rejects(lstat(marker), { code: "ENOENT" });
          else {
            const after = await lstat(marker, { bigint: true });
            const identity = [
              after.ino,
              after.size,
              after.mtimeNs,
              after.ctimeNs,
              after.birthtimeNs,
            ];
            const previous = [
              before.ino,
              before.size,
              before.mtimeNs,
              before.ctimeNs,
              before.birthtimeNs,
            ];
            if (state === "unchanged") assert.deepEqual(identity, previous);
            else assert.notDeepEqual(identity, previous);
          }
          assert.equal(
            edits.length,
            state === "unchanged" ? 1 : 0,
            "retain only the verified unchanged marker; real deletion, replacement and rewrites must revoke the original formatter",
          );
        } finally {
          released.resolve();
          await Promise.allSettled([formatting]);
        }
      },
      { acceptedOperations: ["format"] },
    );
  });
}
