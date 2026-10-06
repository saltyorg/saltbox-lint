import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { observeDirtyReference } from "../host/dirty-reference-observer.ts";

function fixture() {
  const primaryURI = "file:///fixture/roles/readonly/templates/reverse.yaml";
  const aliasURI = "file:///fixture/reverse-alias.j2";
  const original = "😀 lookup('_port')\n";
  const current = original + "secret_unsaved_comment\n";
  const document = {
    uri: { toString: () => primaryURI },
    version: 4,
    isDirty: true,
    isClosed: false,
    getText: () => current,
  };
  const alias = {
    uri: { toString: () => aliasURI },
    version: 5,
    isDirty: false,
    isClosed: false,
    getText: () => original,
  };
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  let calls = 0;
  const native = {
    spawn: (..._args: unknown[]) => {
      calls++;
      return child;
    },
  };
  const inputs = {
    childProcess: native,
    document,
    documents: () => [document, alias],
    tabURIs: () => [primaryURI],
    aliases: [
      { path: "roles/readonly/templates/reverse.yaml", uri: primaryURI },
      { path: "reverse-alias.j2", uri: aliasURI },
    ],
    root: "/fixture",
    owner: "/fixture/roles/readonly/defaults/reverse.yml",
    ownerPath: "roles/readonly/defaults/reverse.yml",
    source: "/fixture/roles/readonly/templates/reverse.yaml",
    position: { line: 0, character: 4 },
    baseline: Buffer.from(original),
    cli: { spellings: ["/installed/saltbox-lint"], identityEqual: true },
  };
  const args = [
    "query",
    "--root",
    inputs.root,
    "--stdin-filename",
    inputs.owner,
    "--stdin-source-filename",
    inputs.source,
    "--operation",
    "references",
    "--offset",
    "6",
    "-",
  ];
  const wire = JSON.stringify({
    schema_version: 1,
    root: inputs.root,
    path: inputs.ownerPath,
    operation: "references",
    offset: 6,
    source_sha256: createHash("sha256").update(current).digest("hex"),
    target_hashes: { [inputs.ownerPath]: "secret_digest" },
    origin: {
      path: inputs.ownerPath,
      span: { start: 5, end: 20 },
      line: 1,
      column: 3,
      text: "lookup('_port')",
    },
    locations: [
      {
        path: inputs.ownerPath,
        span: { start: 5, end: 20 },
        line: 1,
        column: 3,
        text: "lookup('_port')",
      },
    ],
    declarations: [{ value: "secret_declaration_value" }],
    dependencies: {
      root: inputs.root,
      sources: [
        {
          source_sha256: createHash("sha256").update(current).digest("hex"),
          files: [],
        },
      ],
    },
  });
  const result = [
    {
      uri: document.uri,
      range: {
        start: { line: 0, character: 3 },
        end: { line: 0, character: 18 },
      },
    },
  ];
  return {
    inputs,
    document,
    alias,
    original,
    current,
    native,
    child,
    promise,
    resolve,
    reject,
    args,
    wire,
    result,
    calls: () => calls,
  };
}
function facts(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object");
  return value as Record<string, unknown>;
}

test("one original operation preserves its exact promise, native receiver, argv, options, child and stream event result", async () => {
  const f = fixture();
  const options = { env: { secret: "secret_environment" } };
  const nativeReceiver = {};
  f.native.spawn = function (this: unknown, ...argv: unknown[]) {
    assert.equal(this, nativeReceiver);
    assert.equal(argv[0], f.inputs.cli.spellings[0]);
    assert.equal(argv[1], f.args);
    assert.equal(argv[2], options);
    return f.child;
  };
  const spawn = f.native.spawn,
    emit = f.child.emit,
    stdoutEmit = f.child.stdout.emit;
  const observer = observeDirtyReference(f.inputs);
  let requests = 0;
  const pending = observer.request(() => {
    requests++;
    return f.promise;
  });
  assert.equal(pending, f.promise);
  assert.equal(
    Reflect.apply(f.native.spawn, nativeReceiver, [
      f.inputs.cli.spellings[0],
      f.args,
      options,
    ]),
    f.child,
  );
  let forwarded = 0;
  f.child.stdout.on("data", (data: unknown) => {
    assert.equal(data, bytes);
    forwarded++;
  });
  const bytes = Buffer.from(f.wire);
  assert.equal(f.child.stdout.emit("data", bytes), true);
  assert.equal(forwarded, 1);
  f.child.emit("spawn");
  f.child.emit("close", 0, null);
  f.resolve(f.result);
  assert.equal(await pending, f.result);
  assert.equal(requests, 1);
  assert.equal(f.native.spawn, spawn);
  assert.equal(f.child.emit, emit);
  assert.equal(f.child.stdout.emit, stdoutEmit);
  const result = observer.snapshot();
  assert.equal(result.matches, 1);
  assert.equal(result.child?.closed, true);
  assert.equal(facts(result.response).sourceHashMatches, true);
  assert.equal(facts(result.response).dependencySourceHashMatches, true);
  const mapped = facts(result.response).primaryLocations as Record<
    string,
    unknown
  >[];
  assert.ok(
    mapped.every((location) => location.capturedCoordinatesAndTextMatch),
  );
  const output: string[] = [];
  observer.failure((value) => output.push(value));
  assert.doesNotMatch(
    output[0],
    /secret_|[a-f0-9]{64}|\/installed|"\/fixture"/u,
  );
  observer.dispose();
});

for (const state of [
  "conflicting_clean",
  "exact_overlay",
  "closed_earlier",
] as const) {
  test(`public facts distinguish ${state} without changing alias documents or tabs`, async () => {
    const f = fixture();
    if (state === "exact_overlay") {
      f.alias.getText = () => f.current;
      f.alias.isDirty = true;
    }
    if (state === "closed_earlier") f.alias.isClosed = true;
    const before = {
      dirty: f.alias.isDirty,
      closed: f.alias.isClosed,
      text: f.alias.getText(),
      version: f.alias.version,
    };
    const observer = observeDirtyReference(f.inputs);
    const pending = observer.request(() => f.promise);
    f.resolve([]);
    await pending;
    for (const snapshot of [
      observer.snapshot().entry,
      observer.snapshot().settlement,
    ]) {
      const alias = (facts(snapshot).documents as Record<string, unknown>[])[1];
      assert.equal(alias.bytesEqualPrimary, state === "exact_overlay");
      assert.equal(alias.hashEqualsPrimary, state === "exact_overlay");
      assert.equal(alias.bytesEqualLastReadBaseline, state !== "exact_overlay");
      assert.equal(alias.closed, state === "closed_earlier");
      assert.equal(
        facts(snapshot).ownership,
        "fixture_declared_not_independently_observed",
      );
      assert.deepEqual(facts(facts(snapshot).tabs).paths, [
        f.inputs.aliases[0].path,
      ]);
    }
    assert.deepEqual(
      {
        dirty: f.alias.isDirty,
        closed: f.alias.isClosed,
        text: f.alias.getText(),
        version: f.alias.version,
      },
      before,
    );
    observer.dispose();
  });
}

test("unrelated native requests never capture a child; multiple matching candidates are explicitly ambiguous", async () => {
  const f = fixture(),
    observer = observeDirtyReference(f.inputs);
  const spawn = f.native.spawn;
  f.native.spawn(f.inputs.cli.spellings[0], f.args);
  assert.equal(f.native.spawn, spawn);
  const pending = observer.request(() => f.promise);
  for (const [key, value] of [
    ["--operation", "definition"],
    ["--root", "/other"],
    ["--stdin-filename", "/other"],
    ["--stdin-source-filename", "/other"],
    ["--offset", "7"],
  ]) {
    const args = [...f.args];
    args[args.indexOf(key) + 1] = value;
    f.native.spawn(f.inputs.cli.spellings[0], args);
    assert.equal(observer.snapshot().child, undefined);
  }
  f.native.spawn("/unknown/secret_cli", f.args);
  assert.equal(observer.snapshot().child, undefined);
  f.native.spawn(f.inputs.cli.spellings[0], f.args);
  f.native.spawn(f.inputs.cli.spellings[0], f.args);
  f.child.emit("close", 0, null);
  f.resolve([]);
  await pending;
  assert.equal(observer.snapshot().matches, 2);
  assert.equal(
    observer.snapshot().association,
    "ambiguous_matching_native_candidates",
  );
  assert.equal(f.calls(), 9);
  observer.dispose();
});

test("observation exceptions preserve the original request, rejection and final restoration", async () => {
  const f = fixture();
  f.inputs.documents = () => {
    throw new Error("secret_public_observation");
  };
  f.inputs.tabURIs = () => {
    throw new Error("secret_tab");
  };
  f.document.getText = () => {
    throw new Error("secret_text");
  };
  const spawn = f.native.spawn;
  const observer = observeDirtyReference(f.inputs);
  const pending = observer.request(() => f.promise);
  assert.equal(pending, f.promise);
  const original = new Error("original_rejection");
  f.reject(original);
  await assert.rejects(pending, (error: unknown) => error === original);
  assert.equal(f.native.spawn, spawn);
  assert.equal(observer.snapshot().stage, "command_rejected");
  assert.equal(
    facts(observer.snapshot().entry).state,
    "public_observation_unavailable",
  );
  observer.failure(() => {
    throw new Error("secret_writer");
  });
  observer.dispose();
});

test("synchronous request and spawn throws retain exact original errors and restore wrappers", () => {
  for (const boundary of ["request", "spawn"]) {
    const f = fixture();
    const error = new Error("original_error");
    if (boundary === "spawn")
      f.native.spawn = () => {
        throw error;
      };
    const spawn = f.native.spawn;
    const observer = observeDirtyReference(f.inputs);
    try {
      assert.throws(
        () =>
          observer.request(() => {
            if (boundary === "spawn")
              f.native.spawn(f.inputs.cli.spellings[0], f.args);
            throw error;
          }),
        (value: unknown) => value === error,
      );
      assert.equal(f.native.spawn, spawn);
      if (boundary === "spawn")
        assert.equal(observer.snapshot().child?.spawnThrew, true);
    } finally {
      observer.dispose();
    }
  }
});

for (const wire of [
  Buffer.from([0xff]),
  Buffer.from("{secret_invalid_json"),
  Buffer.alloc(256 * 1024 + 1, 0x61),
]) {
  test(`response of ${wire.length} bytes stays bounded and reveals no contents`, async () => {
    const f = fixture(),
      observer = observeDirtyReference(f.inputs);
    const pending = observer.request(() => f.promise);
    f.native.spawn(f.inputs.cli.spellings[0], f.args);
    f.child.stdout.emit("data", wire);
    f.child.stderr.emit("data", Buffer.from("secret_stderr"));
    f.child.emit("close", 2, null);
    f.resolve([]);
    await pending;
    const output: string[] = [];
    observer.failure((value) => output.push(value));
    assert.equal(output.length, 1);
    assert.ok(Buffer.byteLength(output[0]) <= 16 * 1024);
    assert.doesNotMatch(output[0], /secret_|[a-f0-9]{64}/u);
    assert.equal(
      facts(observer.snapshot().response).stage,
      wire.length > 256 * 1024
        ? "response_capture_truncated"
        : "response_invalid",
    );
    observer.dispose();
  });
}

test("oversized buffers, excess tabs/results, unknown result URIs and invalid ranges have explicit facts", async () => {
  const f = fixture();
  f.alias.getText = () => "s".repeat(1024 * 1024 + 1);
  f.inputs.tabURIs = () =>
    Array.from({ length: 19 }, () => f.inputs.aliases[1].uri);
  const observer = observeDirtyReference(f.inputs);
  const pending = observer.request(() => f.promise);
  const result = [
    ...f.result,
    {
      uri: { toString: () => "file:///secret_unknown_path" },
      range: {
        start: { line: -1, character: 0 },
        end: { line: 0, character: 0 },
      },
    },
    ...Array.from({ length: 40 }, () => f.result[0]),
  ];
  f.resolve(result);
  await pending;
  const snapshot = observer.snapshot();
  const alias = (
    facts(snapshot.entry).documents as Record<string, unknown>[]
  )[1];
  assert.equal(alias.capture, "unavailable_above_one_mib");
  assert.equal(alias.hashEqualsPrimary, undefined);
  assert.equal(facts(facts(snapshot.entry).tabs).truncated, true);
  assert.equal(
    (facts(facts(snapshot.entry).tabs).paths as string[]).length,
    16,
  );
  assert.equal(facts(snapshot.results).truncated, true);
  const locations = facts(snapshot.results).locations as Record<
    string,
    unknown
  >[];
  assert.equal(locations.length, 32);
  assert.equal(locations[1].uriAvailable, true);
  assert.equal(locations[1].uri, undefined);
  const output: string[] = [];
  observer.failure((value) => output.push(value));
  assert.doesNotMatch(output[0], /secret_unknown_path/u);
  assert.ok(Buffer.byteLength(output[0]) <= 16 * 1024);
  observer.dispose();
});

test("success stays silent, explicit final disposal restores pending wrappers and does not cancel original work", async () => {
  const f = fixture();
  const spawn = f.native.spawn,
    emit = f.child.emit;
  const observer = observeDirtyReference(f.inputs);
  const pending = observer.request(() => f.promise);
  f.native.spawn(f.inputs.cli.spellings[0], f.args);
  observer.dispose();
  assert.equal(f.native.spawn, spawn);
  assert.equal(f.child.emit, emit);
  f.resolve(f.result);
  assert.equal(await pending, f.result);
  assert.equal(observer.snapshot().stage, "request_entered");
});

test("public document bounds avoid reading an oversized model and preserve closed metadata when getText throws", async () => {
  const f = fixture();
  const document = Object.assign(f.document, {
    positionAt: (offset: number) => ({ line: 0, character: offset }),
    offsetAt: (position: { line: number; character: number }) =>
      position.character,
    getText: () => {
      throw new Error("oversized model must not be read");
    },
  });
  f.alias.isClosed = true;
  f.alias.getText = () => {
    throw new Error("closed model unavailable");
  };
  const observer = observeDirtyReference({ ...f.inputs, document });
  const pending = observer.request(() => f.promise);
  f.resolve([]);
  await pending;
  const snapshot = observer.snapshot();
  assert.equal(snapshot.primaryCapture, "unavailable_above_one_mib");
  const documents = facts(snapshot.entry).documents as Record<
    string,
    unknown
  >[];
  assert.equal(documents[0].capture, "unavailable_above_one_mib");
  assert.equal(documents[1].closed, true);
  assert.equal(documents[1].capture, "unavailable");
  observer.dispose();
});

test("a valid response with wrong primary coordinates exposes equality failure without leaking text", async () => {
  const f = fixture(),
    observer = observeDirtyReference(f.inputs);
  const pending = observer.request(() => f.promise);
  f.native.spawn(f.inputs.cli.spellings[0], f.args);
  const value = JSON.parse(f.wire) as {
    origin: { span: { start: number }; text: string };
  };
  value.origin.span.start = 1;
  value.origin.text = "secret_wrong_source";
  f.child.stdout.emit("data", Buffer.from(JSON.stringify(value)));
  f.child.emit("close", 0, null);
  f.resolve([]);
  await pending;
  const locations = facts(observer.snapshot().response)
    .primaryLocations as Record<string, unknown>[];
  assert.equal(locations[0].capturedCoordinatesAndTextMatch, false);
  assert.equal(locations[1].capturedCoordinatesAndTextMatch, true);
  const output: string[] = [];
  observer.failure((value) => output.push(value));
  observer.failure((value) => output.push(value));
  assert.equal(output.length, 1);
  assert.doesNotMatch(output[0], /secret_wrong_source|[a-f0-9]{64}/u);
  observer.dispose();
});

test("retained original instances expose their own closed state and current workspace models take precedence", async () => {
  const f = fixture();
  f.alias.isClosed = true;
  let documents = [f.document];
  f.inputs.documents = () => documents;
  const unknown = {
    ...f.alias,
    uri: { toString: () => "file:///secret_non_fixture" },
  };
  const observer = observeDirtyReference({
    ...f.inputs,
    retainedDocuments: () => [f.alias, unknown],
  });
  const pending = observer.request(() => f.promise);
  const replacement = {
    ...f.alias,
    isClosed: false,
    isDirty: true,
    version: 9,
    getText: () => f.current,
  };
  documents = [f.document, replacement];
  f.resolve([]);
  await pending;
  const first = (
    facts(observer.snapshot().entry).documents as Record<string, unknown>[]
  )[1];
  assert.equal(first.closed, true);
  assert.equal(first.workspacePresent, false);
  assert.equal(
    first.instanceOrigin,
    "retained_original_sequence_instance_replacement_state_unavailable",
  );
  const current = (
    facts(observer.snapshot().settlement).documents as Record<string, unknown>[]
  )[1];
  assert.equal(current.closed, false);
  assert.equal(current.version, 9);
  assert.equal(current.workspacePresent, true);
  assert.equal(current.instanceOrigin, "current_workspace_model");
  assert.doesNotMatch(
    JSON.stringify(observer.snapshot()),
    /secret_non_fixture/u,
  );
  observer.dispose();
});
