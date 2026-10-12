import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closeTabs,
  type TabCleanupAdapter,
  type TabCleanupChange,
} from "../support/close-tabs.ts";

type Document = { name: string; isDirty: boolean };
type Tab = { name: string; kind: "text" | "diff"; documents: Document[] };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

class TabsFixture {
  tabs: Tab[];
  active: Tab | undefined;
  readonly calls: string[] = [];
  readonly listeners = new Set<(event: TabCleanupChange<Tab>) => void>();
  readonly adapter: TabCleanupAdapter<Tab, Document>;

  constructor(tabs: Tab[]) {
    this.tabs = tabs;
    this.adapter = {
      key: (tab) =>
        JSON.stringify([
          1,
          tab.kind,
          ...tab.documents.map((document) => document.name),
        ]),
      tabs: () => {
        return [...this.tabs];
      },
      dirtyDocuments: (tab) =>
        tab.documents.filter((document) => document.isDirty),
      activeDocumentTab: (document) =>
        this.active?.kind === "text" && this.active.documents[0] === document
          ? this.active
          : undefined,
      onChange: (listener) => {
        this.listeners.add(listener);
        return {
          dispose: () => {
            this.listeners.delete(listener);
          },
        };
      },
      showDocument: async (document) => {
        assert.ok(
          this.listeners.size > 0,
          "activation observation precedes showTextDocument",
        );
        this.calls.push("show " + document.name);
        this.active = this.tabs.find(
          (tab) => tab.kind === "text" && tab.documents[0] === document,
        );
        if (!this.active) {
          this.active = {
            name: "text " + document.name,
            kind: "text",
            documents: [document],
          };
          this.tabs.push(this.active);
        }
        this.emit({ closed: [] });
      },
      discardActive: async () => {
        assert.ok(
          this.listeners.size > 0,
          "close observation precedes the discard command",
        );
        assert.ok(this.active);
        this.calls.push("discard " + this.active.name);
        for (const document of this.active.documents) document.isDirty = false;
        this.close(this.active);
      },
      closeClean: async (tab) => {
        assert.ok(
          this.listeners.size > 0,
          "close observation precedes tabGroups.close",
        );
        this.calls.push("close " + tab.name);
        this.close(tab);
        return true;
      },
    };
  }

  emit(event: TabCleanupChange<Tab>): void {
    for (const listener of this.listeners) listener(event);
  }

  close(tab: Tab): void {
    assert.ok(
      this.tabs.includes(tab),
      "only a current public tab object may be closed",
    );
    this.tabs = this.tabs
      .filter((current) => current !== tab)
      .map((current) => {
        const fresh = { ...current };
        if (this.active === current) this.active = fresh;
        return fresh;
      });
    if (this.active === tab) this.active = undefined;
    this.emit({ closed: [tab] });
  }
}

function text(name: string, dirty = false): Tab {
  return { name, kind: "text", documents: [{ name, isDirty: dirty }] };
}

test("fresh snapshots avoid closing invalid objects retained by an old group", async () => {
  const first = text("first");
  const second = text("second");
  const stale = [first, second];
  const fixture = new TabsFixture(stale);
  await closeTabs(fixture.adapter);
  assert.deepEqual(fixture.calls, ["close first", "close second"]);
  assert.ok(
    stale.includes(second),
    "the obsolete snapshot still contains an invalid tab",
  );
  assert.equal(fixture.listeners.size, 0);
});

test("empty hosts need no close requests or event subscriptions", async () => {
  const fixture = new TabsFixture([]);
  await closeTabs(fixture.adapter);
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.listeners.size, 0);
});

test("whole-model final close is observed through current public absence without a closed event", async () => {
  const fixture = new TabsFixture([text("final")]);
  fixture.adapter.closeClean = async (tab) => {
    assert.ok(fixture.listeners.size > 0);
    fixture.calls.push("close " + tab.name);
    fixture.tabs = [];
    fixture.emit({ closed: [] });
    return true;
  };
  await closeTabs(fixture.adapter);
  assert.deepEqual(fixture.calls, ["close final"]);
  assert.equal(fixture.listeners.size, 0);
});

test("a recreated same-URI tab is still present after a whole-model change", async () => {
  const fixture = new TabsFixture([text("same-uri")]);
  const entered = deferred<void>();
  let current;
  fixture.adapter.closeClean = async () => {
    current = text("same-uri");
    fixture.tabs = [current];
    fixture.emit({ closed: [] });
    entered.resolve();
    return true;
  };
  let completed = false;
  const pending = closeTabs(fixture.adapter).then(() => {
    completed = true;
  });
  await entered.promise;
  await Promise.resolve();
  try {
    assert.equal(
      completed,
      false,
      "object replacement cannot prove the public resource closed",
    );
  } finally {
    fixture.tabs = [];
    fixture.emit({ closed: [] });
    await pending;
  }
  assert.equal(fixture.listeners.size, 0);
});

test("API completion checks current absence even when no model event is delivered", async () => {
  const fixture = new TabsFixture([text("final")]);
  fixture.adapter.closeClean = async () => {
    fixture.tabs = [];
    return true;
  };
  await closeTabs(fixture.adapter);
  assert.equal(fixture.listeners.size, 0);
});

test("dirty text documents use discard and never a dialog-producing close", async () => {
  const fixture = new TabsFixture([text("dirty", true), text("clean")]);
  await closeTabs(fixture.adapter);
  assert.deepEqual(fixture.calls, [
    "show dirty",
    "discard dirty",
    "close clean",
  ]);
  assert.equal(fixture.listeners.size, 0);
});

test("dirty diffs discard each active text resource then close the fresh clean diff", async () => {
  const original = { name: "original", isDirty: true };
  const modified = { name: "modified", isDirty: true };
  const fixture = new TabsFixture([
    { name: "diff", kind: "diff", documents: [original, modified] },
  ]);
  await closeTabs(fixture.adapter);
  assert.deepEqual(fixture.calls, [
    "show original",
    "discard text original",
    "show modified",
    "discard text modified",
    "close diff",
  ]);
  assert.equal(original.isDirty, false);
  assert.equal(modified.isDirty, false);
  assert.equal(fixture.listeners.size, 0);
});

test("discard can close the existing diff when showTextDocument reuses its editor", async () => {
  const document = { name: "modified", isDirty: true };
  const tab: Tab = { name: "diff", kind: "diff", documents: [document] };
  const fixture = new TabsFixture([tab]);
  fixture.adapter.showDocument = async () => {
    fixture.active = tab;
    fixture.calls.push("show modified");
    fixture.emit({ closed: [] });
  };
  fixture.adapter.activeDocumentTab = (candidate) =>
    fixture.active?.documents.includes(candidate) ? fixture.active : undefined;
  await closeTabs(fixture.adapter);
  assert.deepEqual(fixture.calls, ["show modified", "discard diff"]);
  assert.equal(fixture.listeners.size, 0);
});

test("a close event before API return still waits for the admitted command promise", async () => {
  const fixture = new TabsFixture([text("first"), text("second")]);
  const completed = deferred<boolean>();
  const entered = deferred<void>();
  const realClose = fixture.adapter.closeClean;
  fixture.adapter.closeClean = (tab) => {
    if (tab.name !== "first") return realClose(tab);
    fixture.calls.push("close first");
    fixture.close(tab);
    entered.resolve();
    return completed.promise;
  };
  const pending = closeTabs(fixture.adapter);
  await entered.promise;
  try {
    assert.deepEqual(fixture.calls, ["close first"]);
    assert.equal(fixture.listeners.size, 1);
  } finally {
    completed.resolve(true);
    await pending;
  }
  assert.deepEqual(fixture.calls, ["close first", "close second"]);
  assert.equal(fixture.listeners.size, 0);
});

test("public activation state can arrive after the show promise", async () => {
  const tab = text("dirty", true);
  const fixture = new TabsFixture([tab]);
  const entered = deferred<void>();
  fixture.adapter.showDocument = async () => {
    fixture.calls.push("show dirty");
    entered.resolve();
  };
  const pending = closeTabs(fixture.adapter);
  await entered.promise;
  await Promise.resolve();
  try {
    assert.deepEqual(fixture.calls, ["show dirty"]);
    assert.equal(fixture.listeners.size, 1);
  } finally {
    fixture.active = tab;
    fixture.emit({ closed: [] });
    await pending;
  }
  assert.deepEqual(fixture.calls, ["show dirty", "discard dirty"]);
  assert.equal(fixture.listeners.size, 0);
});

test("unrelated close events cannot release the selected tab observation", async () => {
  const first = text("first");
  const fixture = new TabsFixture([first]);
  const entered = deferred<void>();
  fixture.adapter.closeClean = async () => {
    entered.resolve();
    return true;
  };
  let settled = false;
  const pending = closeTabs(fixture.adapter).then(() => {
    settled = true;
  });
  await entered.promise;
  fixture.emit({ closed: [text("unrelated")] });
  await Promise.resolve();
  try {
    assert.equal(settled, false);
  } finally {
    fixture.close(first);
    await pending;
  }
  assert.equal(fixture.listeners.size, 0);
});

test("a refused clean close disposes its observation and reports failure", async () => {
  const fixture = new TabsFixture([text("blocked")]);
  fixture.adapter.closeClean = async () => false;
  await assert.rejects(closeTabs(fixture.adapter), /close was refused/);
  assert.equal(fixture.listeners.size, 0);
  assert.equal(fixture.tabs.length, 1);
});

test("failed active-tab observation reports its cause after show settles", async () => {
  const fixture = new TabsFixture([text("dirty", true)]);
  const failure = new Error("active tab state failed");
  fixture.adapter.activeDocumentTab = () => {
    throw failure;
  };
  await assert.rejects(
    closeTabs(fixture.adapter),
    (error) => error === failure,
  );
  assert.equal(fixture.listeners.size, 0);
});

for (const phase of ["show", "discard", "close"] as const) {
  test(`${phase} failures preserve the original error and dispose event subscriptions`, async () => {
    const fixture = new TabsFixture([text("fixture", phase !== "close")]);
    const failure = new Error("controlled " + phase + " failure");
    const fail = async () => {
      throw failure;
    };
    if (phase === "show") fixture.adapter.showDocument = fail;
    else if (phase === "discard") fixture.adapter.discardActive = fail;
    else fixture.adapter.closeClean = fail;
    await assert.rejects(
      closeTabs(fixture.adapter),
      (error) => error === failure,
    );
    assert.equal(fixture.listeners.size, 0);
  });
}

test("abort before admission starts no editor operation", async () => {
  const fixture = new TabsFixture([text("dirty", true)]);
  const cancellation = new AbortController();
  const failure = new Error("cleanup already canceled");
  cancellation.abort(failure);
  await assert.rejects(
    closeTabs(fixture.adapter, cancellation.signal),
    (error) => error === failure,
  );
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.listeners.size, 0);
});

for (const phase of ["show", "discard", "close"] as const) {
  test(`abort during ${phase} joins the admitted promise before failing`, async () => {
    const fixture = new TabsFixture([text("fixture", phase !== "close")]);
    const cancellation = new AbortController();
    const entered = deferred<void>();
    const completed = deferred<boolean>();
    const pendingCommand = () => {
      entered.resolve();
      return completed.promise;
    };
    if (phase === "show") fixture.adapter.showDocument = pendingCommand;
    else if (phase === "discard")
      fixture.adapter.discardActive = pendingCommand;
    else fixture.adapter.closeClean = pendingCommand;
    const reason = new Error("controlled cleanup cancellation");
    let settled = false;
    const rejection = assert
      .rejects(
        closeTabs(fixture.adapter, cancellation.signal),
        (error) => error === reason,
      )
      .then(() => {
        settled = true;
      });
    await entered.promise;
    cancellation.abort(reason);
    await Promise.resolve();
    try {
      assert.equal(
        settled,
        false,
        "signal delivery cannot substitute for API command settlement",
      );
      assert.equal(fixture.listeners.size, 1);
    } finally {
      completed.resolve(true);
      await rejection;
    }
    assert.equal(fixture.listeners.size, 0);
  });
}
