import {
  runManualLiveControl,
  runSaveLiveControl,
} from "../support/live-controls.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

for (const failure of [
  "none",
  "uncancelled typing",
  "unclosed typing",
  "missing manual child",
  "duplicate manual child",
  "unclosed manual child",
  "cancelled manual child",
  "unsuccessful manual child",
  "incorrect manual findings",
] as const) {
  test(`actual manual host sequence checks the compact primary and rejects ${failure}`, async () => {
    const events: string[] = [];
    const small = {},
      heavy = {};
    const controlledInvocations = new Map();
    const requests: {
      closed?: number;
      cancelled?: boolean;
      exitCode?: number;
    }[] = [];
    let restored = false;
    const window = {
      activeTextEditor: { document: heavy },
      showTextDocument: async (document: object) => {
        window.activeTextEditor = { document };
        events.push(document === small ? "focus small" : "focus heavy");
      },
    };
    const context = {
      assert,
      small,
      heavy,
      evidence: undefined,
      source: (line: number) => `compact ${line}`,
      primaryCalls: (document: object) => {
        assert.equal(document, small);
        return requests;
      },
      controlledInvocations,
      vscode: {
        window,
        commands: {
          executeCommand: async (command: string) => {
            assert.equal(command, "saltboxLint.checkDocument");
            assert.equal(window.activeTextEditor.document, small);
            assert.equal(restored, false);
            events.push("manual command");
            controlledInvocations.set("manual", {
              cancelled: failure !== "uncancelled typing",
              closed: failure === "unclosed typing" ? undefined : 1,
            });
            if (failure !== "missing manual child")
              requests.push({
                closed: failure === "unclosed manual child" ? undefined : 2,
                cancelled: failure === "cancelled manual child",
                exitCode: failure === "unsuccessful manual child" ? 2 : 1,
              });
            if (failure === "duplicate manual child")
              requests.push({ closed: 2, cancelled: false, exitCode: 1 });
          },
        },
      },
      cancelControl: async (name: string, action: () => Promise<void>) => {
        assert.equal(name, "manual");
        assert.equal(window.activeTextEditor.document, small);
        controlledInvocations.set("manual", {});
        events.push("heavy control launched");
        await action();
        return 10;
      },
      expected: (document: object, line: number) =>
        document === small
          ? line === 59 && failure !== "incorrect manual findings"
          : document === heavy && line === 92 && restored,
      replace: async (document: object, text: string, name: string) => {
        assert.equal(document, heavy);
        assert.equal(text, "compact 92");
        assert.equal(name, "manual-restored-edit");
        const typing = controlledInvocations.get("manual");
        assert.equal(typing.cancelled, true);
        assert.notEqual(typing.closed, undefined);
        restored = true;
        events.push("restore heavy");
      },
      observed: async (predicate: () => boolean) => {
        assert.equal(predicate(), true);
        events.push("compact findings accepted");
      },
      checkpoint: async (name: string) => {
        assert.equal(name, "manual");
        assert.equal(window.activeTextEditor.document, heavy);
        assert.equal(restored, true);
        events.push("manual checkpoint");
      },
    };
    const operation = () => runManualLiveControl(context);
    if (failure !== "none") {
      await assert.rejects(operation());
      assert.equal(events.includes("restore heavy"), false);
      return;
    }
    assert.equal(await operation(), 10);
    assert.deepEqual(events, [
      "focus small",
      "heavy control launched",
      "manual command",
      "restore heavy",
      "compact findings accepted",
      "focus heavy",
      "manual checkpoint",
    ]);
  });
}

for (const failure of [
  "none",
  "uncancelled typing",
  "unclosed typing",
  "unaccepted save",
  "unaccepted compact restoration",
] as const) {
  test(`actual save host sequence proves cancellation and fresh findings for ${failure}`, async () => {
    const events: string[] = [];
    const heavy = {};
    const controlledInvocations = new Map();
    let restored = false;
    const small = {
      save: async () => {
        assert.equal(restored, false);
        events.push("actual save");
        controlledInvocations.set("save", {
          cancelled: failure !== "uncancelled typing",
          closed: failure === "unclosed typing" ? undefined : 1,
        });
      },
    };
    const context = {
      assert,
      small,
      heavy,
      evidence: undefined,
      source: (line: number) => `compact ${line}`,
      controlledInvocations,
      cancelControl: async (name: string, action: () => Promise<void>) => {
        assert.equal(name, "save");
        events.push("heavy control launched");
        await action();
        return 10;
      },
      expected: (document: object, line: number) =>
        document === small
          ? line === 91 && failure !== "unaccepted save"
          : document === heavy &&
            line === 93 &&
            restored &&
            failure !== "unaccepted compact restoration",
      replace: async (document: object, text: string, name: string) => {
        assert.equal(document, heavy);
        assert.equal(text, "compact 93");
        assert.equal(name, "save-restored-edit");
        const typing = controlledInvocations.get("save");
        assert.equal(typing.cancelled, true);
        assert.notEqual(typing.closed, undefined);
        restored = true;
        events.push("restore heavy");
      },
      observed: async (predicate: () => boolean) => {
        assert.equal(predicate(), true);
        events.push(
          restored ? "compact findings accepted" : "saved findings accepted",
        );
      },
      checkpoint: async (name: string) => {
        assert.equal(name, "save");
        assert.equal(restored, true);
        events.push("save checkpoint");
      },
    };
    const operation = () => runSaveLiveControl(context);
    if (failure !== "none") {
      await assert.rejects(operation());
      assert.equal(events.includes("save checkpoint"), false);
      if (failure !== "unaccepted compact restoration")
        assert.equal(events.includes("restore heavy"), false);
      return;
    }
    assert.equal(await operation(), 10);
    assert.deepEqual(events, [
      "heavy control launched",
      "actual save",
      "saved findings accepted",
      "restore heavy",
      "compact findings accepted",
      "save checkpoint",
    ]);
  });
}
