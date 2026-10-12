import * as vscode from "vscode";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { editorAcceptance } from "./editor-acceptance.ts";
import { getHostProfile } from "./host-profile.ts";
import { verifyInstalledProduct } from "./host-preflight.ts";
import {
  activatedDocument,
  runDiagnostics,
  runEditing,
} from "./normal-cases.ts";
import type { TestResources } from "../support/test-resources.ts";
import { runHostSuite } from "../support/host-suite.ts";
import { closeEditorTabs } from "../support/editor-tabs.ts";
import { ownJoinedResource } from "../support/host-resources.ts";
import { joinInstalledRuntime } from "../support/installed-runtime.ts";
import { withHostFailureEvidence } from "../support/host-failure.ts";

async function joinProduct(): Promise<void> {
  const product = vscode.extensions.getExtension("saltyorg.saltbox-lint");
  if (!product?.isActive) return;
  const require = createRequire(__filename);
  const filename = require.resolve(
    join(product.extensionPath, "dist", "extension.js"),
  );
  await joinInstalledRuntime(filename, require.cache);
}

export async function exerciseProfile(resources: TestResources): Promise<void> {
  const profile = getHostProfile(process.env);
  switch (profile) {
    case "disabled":
      assert.equal(
        vscode.extensions.getExtension("saltyorg.saltbox-lint")?.isActive ??
          false,
        false,
      );
      return;
    case "untrusted": {
      assert.equal(vscode.workspace.isTrusted, false);
      const uri = vscode.Uri.joinPath(
        vscode.workspace.workspaceFolders![0].uri,
        "roles/example/defaults/main.yml",
      );
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(uri),
      );
      assert.equal(
        vscode.extensions.getExtension("saltyorg.saltbox-lint")?.isActive ??
          false,
        false,
      );
      assert.deepEqual(
        vscode.languages
          .getDiagnostics(uri)
          .filter((item) => item.source === "saltbox-lint"),
        [],
      );
      return;
    }
    case "dependencies":
      return (await import("./dependencies.ts")).runDependencies(
        resources.signal,
      );
    case "queue":
      return (await import("./queue.ts")).runQueue(resources.signal);
    case "active-project":
    case "active-project-cache":
      return (await import("./active-project.ts")).runActiveProject(
        resources.signal,
      );
    case "save-scope":
      return (await import("./save-scope.ts")).runSaveScope(resources.signal);
    case "markers":
      return (await import("./markers.ts")).runMarkers(resources.signal);
    case "profile":
      return (await import("./profile.ts")).runProfile(resources.signal);
    case "qualification":
      return (await import("./qualification.ts")).runQualification(
        resources.signal,
      );
    case "regressions":
      return (await import("./regressions.ts")).runRegressions(
        resources.signal,
      );
    case "normal":
      await activatedDocument();
      return;
    case "navigation":
      await activatedDocument();
      return (await import("./navigation.ts")).runNavigation(resources.signal);
    case "templates":
      await activatedDocument();
      return (await import("./templates.ts")).runTemplates(resources.signal);
    case "help-status": {
      const { document } = await activatedDocument();
      await vscode.commands.executeCommand("saltboxLint.checkDocument");
      return (await import("./help-status.ts")).runHelpStatus(
        document,
        resources.signal,
      );
    }
    case "editing":
      return runEditing(resources);
    case "diagnostics":
      return runDiagnostics(resources);
    case "live-checking":
      await activatedDocument();
      return (await import("./live-checking.ts")).runLiveChecking(
        resources.signal,
      );
    case "live-performance":
      return (await import("./live-checking.ts")).runLivePerformance(
        resources.signal,
      );
  }
  const unhandled: never = profile;
  throw new Error(`Unhandled extension host profile ${String(unhandled)}`);
}

/** Public test-electron entry point; each profile has named Mocha cases. */
export async function run(): Promise<void> {
  const profile = getHostProfile(process.env);
  const started = performance.now();
  await withHostFailureEvidence(() =>
    runHostSuite(profile, async () => {
      const product = vscode.extensions.getExtension("saltyorg.saltbox-lint");
      const installationState = verifyInstalledProduct(
        process.env,
        product && {
          id: product.id,
          extensionPath: product.extensionPath,
          version: (product.packageJSON as { version?: unknown }).version,
        },
      );
      const require = createRequire(__filename);
      const mochaVersion = (
        require("mocha/package.json") as { version: string }
      ).version;
      const sdkVersion = (
        require("@vscode/test-electron/package.json") as { version: string }
      ).version;
      console.log(
        "SALTBOX_EDITOR_ACCEPTANCE " +
          JSON.stringify({
            ...editorAcceptance({
              expectedVersion: process.env.SALTBOX_TEST_EXPECTED_VSCODE_VERSION,
              actualVersion: vscode.version,
              platform: process.platform,
              arch: process.arch,
              mode: profile,
              appRoot: vscode.env.appRoot,
              controllerPath: __filename,
              cliPath: process.env.SALTBOX_TEST_INSTALLED_CLI_PATH,
              proxyPath:
                process.env.SALTBOX_TEST_SAVE_SCOPE === "1"
                  ? process.env.SALTBOX_TEST_FIXTURE_PATH
                  : undefined,
            }),
            runtime: {
              node: process.versions.node,
              electron: process.versions.electron,
            },
            tools: { mocha: mochaVersion, testElectron: sdkVersion },
            installation: {
              state: installationState,
              userData: process.env.SALTBOX_TEST_USER_DATA_DIR,
              extensions: process.env.SALTBOX_TEST_EXTENSIONS_DIR,
              workspace: process.env.SALTBOX_TEST_WORKSPACE_PATH,
            },
          }),
      );
    }, [
      {
        name: profile + " behavior and owned cleanup",
        async exercise(resources) {
          let closing:
            Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
          ownJoinedResource(resources, "installed product lifecycle", {
            dispose() {
              closing ??= joinProduct().then(
                (): { ok: true } => ({ ok: true }),
                (error: unknown): { ok: false; error: unknown } => ({
                  ok: false,
                  error,
                }),
              );
            },
            async join() {
              const outcome = await closing;
              if (outcome && !outcome.ok) throw outcome.error;
            },
          });
          resources.defer("editor tabs", closeEditorTabs);
          await exerciseProfile(resources);
        },
      },
    ]),
  );
  console.log(
    "SALTBOX_EDITOR_CASE " +
      JSON.stringify({
        profile,
        elapsedMs: performance.now() - started,
        outcome: "joined",
      }),
  );
}
