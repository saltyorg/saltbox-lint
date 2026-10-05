import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type * as vscode from "vscode";
import {
  reportStartupFailure,
  startupFailureReport,
} from "../host/startup-failure.ts";

test("startup failure reports actual public identities without contents or private state", () => {
  const temporary = mkdtempSync(join(tmpdir(), "saltbox-startup-report-"));
  try {
    const uri = (path: string) => ({
      fsPath: path,
      scheme: "file",
      toString: () => `file://${path}`,
    });
    const roots = ["one", "two"].map((name) => ({
      uri: uri(join(temporary, name)),
    }));
    for (const root of roots) {
      mkdirSync(join(root.uri.fsPath, "roles/example/defaults"), {
        recursive: true,
      });
      writeFileSync(join(root.uri.fsPath, ".saltbox-lint"), "");
      writeFileSync(
        join(root.uri.fsPath, "roles/example/defaults/main.yml"),
        "private fixture text\n",
      );
    }
    const appRoot = join(temporary, "sdk");
    mkdirSync(appRoot);
    writeFileSync(
      join(appRoot, "product.json"),
      JSON.stringify({
        commit: "actual shipped SDK commit",
        version: "actual shipped SDK version",
        privateField: "must not report this",
      }),
    );
    const extensionPath = join(temporary, "installed");
    mkdirSync(join(extensionPath, "dist"), { recursive: true });
    writeFileSync(
      join(extensionPath, "dist/extension.js"),
      "actual runtime bytes",
    );
    const uris = roots.map((root) =>
      uri(join(root.uri.fsPath, "roles/example/defaults/main.yml")),
    );
    const document = {
      uri: uris[1],
      version: 7,
      languageId: "yaml",
      isDirty: true,
      isClosed: false,
    };
    const tab = {
      isActive: true,
      isDirty: true,
      isPinned: false,
      isPreview: false,
    };
    const api = {
      version: "actual public SDK version",
      env: { appRoot, appName: "Actual editor" },
      window: {
        activeTextEditor: { document },
        visibleTextEditors: [{ document }],
        tabGroups: { all: [{ isActive: true, viewColumn: 2, tabs: [tab] }] },
      },
      workspace: {
        textDocuments: [document],
        getConfiguration: (_name: string, scope?: (typeof uris)[0]) => ({
          get: () => (scope?.fsPath === roots[1].uri.fsPath ? false : true),
          inspect: () => ({
            key: "saltboxLint.activeProjectOnly",
            defaultValue: true,
            workspaceFolderValue:
              scope?.fsPath === roots[1].uri.fsPath ? false : undefined,
          }),
        }),
      },
      languages: {
        getDiagnostics: (tested: (typeof uris)[0]) =>
          tested === uris[0]
            ? []
            : [
                { source: "unrelated", code: "ignored" },
                {
                  source: "saltbox-lint",
                  code: { value: "jinja-layout" },
                  severity: 0,
                  range: {
                    start: { line: 1, character: 3 },
                    end: { line: 2, character: 4 },
                  },
                },
              ],
      },
      extensions: {
        getExtension: () => ({
          id: "saltyorg.saltbox-lint",
          extensionPath,
          extensionUri: uri(extensionPath),
          isActive: true,
          packageJSON: {
            version: "test install version",
            main: "./dist/extension.js",
          },
        }),
      },
    };
    const report = startupFailureReport(
      api as unknown as typeof vscode,
      roots as unknown as vscode.WorkspaceFolder[],
      uris as unknown as vscode.Uri[],
      () => uris as unknown as vscode.Uri[],
      join(extensionPath, "dist/extension.js"),
    );
    // URI values must be serialized strings rather than SDK objects.
    const expectedDocument = {
      ...document,
      uri: uris[1].toString(),
      scheme: "file",
    };
    assert.deepEqual(report.activeEditor, {
      available: true,
      value: expectedDocument,
    });
    assert.deepEqual(report.loadedDocuments, {
      available: true,
      value: [expectedDocument],
    });
    assert.ok(report.tabGroups.available);
    assert.deepEqual(report.tabGroups.value[0].tabs[0].uris, uris.map(String));
    const first = report.roots[0],
      second = report.roots[1];
    assert.equal(first.uri, roots[0].uri.toString());
    assert.equal(second.testedUri, uris[1].toString());
    assert.deepEqual(first.displayedDiagnostics, {
      available: true,
      value: { count: 0, diagnostics: [] },
    });
    assert.ok(second.displayedDiagnostics.available);
    assert.deepEqual(second.displayedDiagnostics.value, {
      count: 1,
      diagnostics: [
        {
          code: "jinja-layout",
          severity: 0,
          range: {
            start: { line: 1, character: 3 },
            end: { line: 2, character: 4 },
          },
        },
      ],
    });
    assert.ok(second.configuration.available);
    assert.equal(second.configuration.value.workspaceFolderValue, false);
    assert.equal(second.configuration.value.workspaceValue, null);
    assert.equal(second.configuration.value.effective, false);
    const main = first.fixtures.find((file) =>
      file.path.endsWith("/main.yml"),
    )!;
    assert.equal(
      main.sha256,
      createHash("sha256").update("private fixture text\n").digest("hex"),
    );
    assert.equal(first.fixtures[0].present, true);
    assert.equal(
      first.fixtures.find((file) => file.path.endsWith("README.md"))!.present,
      false,
    );
    assert.ok(report.sdk.available);
    assert.ok(report.sdk.value.product.available);
    assert.equal(
      report.sdk.value.product.value.commit,
      "actual shipped SDK commit",
    );
    assert.ok(report.product.available);
    assert.equal(report.product.value.extensionPath, extensionPath);
    assert.ok("sha256" in report.product.value.runtime);
    assert.equal(
      report.product.value.runtime.sha256,
      createHash("sha256").update("actual runtime bytes").digest("hex"),
    );
    assert.equal(report.product.value.cli.present, false);
    assert.equal(report.process.node, process.versions.node);
    assert.equal(report.process.electron, process.versions.electron ?? null);
    const encoded = JSON.stringify(report);
    assert.ok(!encoded.includes("private fixture text"));
    assert.ok(!encoded.includes("must not report this"));
    assert.ok(!encoded.includes("activeFile"));
    // A failing public query leaves other observations available, not a fake zero count.
    api.languages.getDiagnostics = () => {
      throw new Error("diagnostics unavailable");
    };
    const unavailable = startupFailureReport(
      api as unknown as typeof vscode,
      roots as unknown as vscode.WorkspaceFolder[],
      uris as unknown as vscode.Uri[],
      () => [],
      join(extensionPath, "dist/extension.js"),
    );
    assert.deepEqual(unavailable.roots[0].displayedDiagnostics, {
      available: false,
      reason: "diagnostics unavailable",
    });
    assert.ok(unavailable.activeEditor.available);
    rmSync(join(appRoot, "product.json"));
    const missingSDK = startupFailureReport(
      api as unknown as typeof vscode,
      roots as unknown as vscode.WorkspaceFolder[],
      uris as unknown as vscode.Uri[],
      () => [],
      join(extensionPath, "dist/extension.js"),
    );
    assert.ok(missingSDK.sdk.available);
    assert.equal(missingSDK.sdk.value.version, "actual public SDK version");
    assert.equal(missingSDK.sdk.value.product.available, false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("failure reporting preserves the original error through collection and logger failures", () => {
  const original = new Error("original startup assertion");
  const output: string[] = [];
  assert.throws(
    () =>
      reportStartupFailure(
        original,
        () => ({ actual: true }),
        (line) => output.push(line),
      ),
    (error) => error === original,
  );
  assert.deepEqual(output, ['ACTIVE_PROJECT_STARTUP_FAILURE {"actual":true}']);
  assert.throws(
    () =>
      reportStartupFailure(
        original,
        () => {
          throw new Error("read failed");
        },
        () => assert.fail("cannot emit failed capture"),
      ),
    (error) => error === original,
  );
  assert.throws(
    () =>
      reportStartupFailure(
        original,
        () => ({ actual: true }),
        () => {
          throw new Error("logger failed");
        },
      ),
    (error) => error === original,
  );
});

test("real startup call site collects only on rejection and retains the original wait", async () => {
  const source = readFileSync("test/host/active-project.ts", "utf8");
  assert.match(
    source,
    /const deadline = Date.now\(\) \+ 10000;\s+while \(!predicate\(\) && Date.now\(\) < deadline\) await pause\(25\);\s+assert.ok\(predicate\(\), message\);/,
  );
  const bundled = await build({
    entryPoints: ["test/host/active-project.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    plugins: [
      {
        name: "startup-public-api",
        setup(builder) {
          builder.onResolve(
            { filter: /^vscode$|editor\.ts$|startup-failure\.ts$/ },
            ({ path }) => ({ path, namespace: "startup-test" }),
          );
          builder.onLoad(
            { filter: /.*/, namespace: "startup-test" },
            ({ path }) => ({
              contents:
                path === "vscode"
                  ? "module.exports = globalThis.api"
                  : path.endsWith("editor.ts")
                    ? "exports.tabDocumentUris = () => []; exports.EditorIntegration = class {};"
                    : "exports.startupFailureReport = () => { globalThis.captures++; return {}; }; exports.reportStartupFailure = globalThis.reportStartupFailure;",
              loader: "js",
            }),
          );
        },
      },
    ],
  });
  const original = new Error("original public query rejection");
  const afterStartup = new Error("stop after successful startup");
  for (const outcome of [
    "success",
    "predicate rejection",
    "assertion rejection",
  ]) {
    let reportedError: unknown;
    let clockReads = 0;
    const context = {
      captures: 0,
      reportStartupFailure: (error: unknown, capture: () => unknown) => {
        reportedError = error;
        return reportStartupFailure(error, capture, () => {});
      },
      api: {
        workspace: {
          workspaceFolders: [{ uri: {} }, { uri: {} }],
          getConfiguration: () => ({
            inspect: () => {
              throw afterStartup;
            },
          }),
        },
        Uri: { joinPath: () => ({}) },
        window: {},
        extensions: { getExtension: () => ({ activate: async () => {} }) },
        languages: {
          createDiagnosticCollection: () => ({ dispose() {} }),
          getDiagnostics: () => {
            if (outcome === "predicate rejection") throw original;
            return outcome === "success" ? [{ source: "saltbox-lint" }] : [];
          },
        },
      },
      module: { exports: {} as { runActiveProject: () => Promise<void> } },
      exports: {},
      require: createRequire(import.meta.url),
      process: { env: {} },
      console: { log() {}, error() {} },
      __filename: "actual-test-controller",
      Date: { now: () => (clockReads++ === 0 ? 0 : 10001) },
      setTimeout,
    };
    context.exports = context.module.exports;
    runInNewContext(bundled.outputFiles[0].text, context);
    await assert.rejects(context.module.exports.runActiveProject(), (error) => {
      if (outcome === "success") return error === afterStartup;
      assert.equal(
        error,
        reportedError,
        "the exact reported error must escape",
      );
      if (outcome === "predicate rejection") return error === original;
      assert.match(
        (error as Error).message,
        /startup without file context shows both cached projects/,
      );
      return true;
    });
    assert.equal(context.captures, outcome === "success" ? 0 : 1);
  }
});
