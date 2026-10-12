import type * as vscode from "vscode";
import type { EditorAdapters } from "../../src/editor.ts";
import { TestResources } from "./test-resources.ts";

/** Component controls own private UI sinks. Installed UI contracts use real APIs. */
export function componentUI(resources: TestResources): Pick<
  EditorAdapters,
  "createOutputChannel"
> & {
  createStatusBarItem: typeof vscode.window.createStatusBarItem;
  snapshot(): { outputChannels: number; statusBars: number };
} {
  const outputs: { disposed: boolean }[] = [];
  const statuses: { disposed: boolean }[] = [];
  function createOutputChannel(name: string): vscode.OutputChannel {
    const state = { disposed: false };
    const write = () => {
      if (state.disposed)
        throw new Error("Component output was already disposed");
    };
    const channel: vscode.OutputChannel = {
      name,
      append: write,
      appendLine: write,
      replace: write,
      clear: write,
      show: write,
      hide: write,
      dispose() {
        state.disposed = true;
      },
    };
    resources.defer(`component output ${name}`, () => channel.dispose());
    outputs.push(state);
    if (resources.signal.aborted) channel.dispose();
    return channel;
  }
  function createStatusBarItem(
    id: string,
    alignment?: vscode.StatusBarAlignment,
    priority?: number,
  ): vscode.StatusBarItem;
  function createStatusBarItem(
    alignment?: vscode.StatusBarAlignment,
    priority?: number,
  ): vscode.StatusBarItem;
  function createStatusBarItem(
    first?: string | vscode.StatusBarAlignment,
    second?: number,
    third?: number,
  ): vscode.StatusBarItem {
    const state = { disposed: false };
    const item: vscode.StatusBarItem = {
      id: typeof first === "string" ? first : "component-status",
      alignment: typeof first === "string" ? (second ?? 1) : (first ?? 1),
      priority: typeof first === "string" ? third : second,
      text: "",
      name: undefined,
      tooltip: undefined,
      color: undefined,
      backgroundColor: undefined,
      command: undefined,
      accessibilityInformation: undefined,
      show() {
        // Supported VS Code status entries ignore show/update after disposal.
      },
      hide() {},
      dispose() {
        state.disposed = true;
      },
    };
    resources.defer(`component status ${item.id}`, () => item.dispose());
    statuses.push(state);
    if (resources.signal.aborted) item.dispose();
    return item;
  }
  return {
    createOutputChannel,
    createStatusBarItem,
    snapshot: () => ({
      outputChannels: outputs.filter((state) => !state.disposed).length,
      statusBars: statuses.filter((state) => !state.disposed).length,
    }),
  };
}
