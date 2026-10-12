import assert from "node:assert/strict";
import { test } from "node:test";
import { componentUI } from "../support/component-ui.ts";
import { TestResources, withTestResources } from "../support/test-resources.ts";

test("half-completed component setup releases its privately owned UI sinks", async () => {
  let ui: ReturnType<typeof componentUI> | undefined;
  const failure = new Error("later setup failed");
  await assert.rejects(
    withTestResources({ cleanupTimeoutMs: 1000 }, (resources) => {
      ui = componentUI(resources);
      ui.createOutputChannel("component").appendLine("setup");
      ui.createStatusBarItem(1, 0).show();
      assert.deepEqual(ui.snapshot(), { outputChannels: 1, statusBars: 1 });
      throw failure;
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      return true;
    },
  );
  assert.deepEqual(ui?.snapshot(), { outputChannels: 0, statusBars: 0 });
});

test("component UI preserves both status factory forms and disallows late resource use", async () => {
  const resources = new TestResources({ cleanupTimeoutMs: 1000 });
  const ui = componentUI(resources);
  const first = ui.createStatusBarItem(2, 5);
  const second = ui.createStatusBarItem("named", 1, 7);
  assert.deepEqual([first.alignment, first.priority], [2, 5]);
  assert.deepEqual(
    [second.id, second.alignment, second.priority],
    ["named", 1, 7],
  );
  const output = ui.createOutputChannel("component");
  await resources.close();
  assert.throws(() => output.appendLine("late output"), /already disposed/);
  assert.doesNotThrow(() => first.show());
  assert.throws(() => ui.createOutputChannel("too late"), /while closed/);
  assert.deepEqual(ui.snapshot(), { outputChannels: 0, statusBars: 0 });
});

test("independent UI owners cannot release each other's sinks", async () => {
  const first = new TestResources({ cleanupTimeoutMs: 1000 });
  const second = new TestResources({ cleanupTimeoutMs: 1000 });
  const a = componentUI(first),
    b = componentUI(second);
  a.createOutputChannel("same name");
  b.createOutputChannel("same name");
  await first.close();
  assert.deepEqual(a.snapshot(), { outputChannels: 0, statusBars: 0 });
  assert.deepEqual(b.snapshot(), { outputChannels: 1, statusBars: 0 });
  await second.close();
});
