import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  observeFirstDefinition,
  withFirstDefinitionObservation,
} from "../host/first-definition-observer.ts";

function setup() {
  const uri = {
    fsPath: "/fixture/source.yml",
    toString: () => "file:///fixture/source.yml",
  };
  const position = { line: 0, character: 2 };
  const document = {
    uri,
    version: 3,
    isDirty: false,
    isClosed: false,
    getText: () => "😀 secret_source_value",
    offsetAt: () => 2,
  };
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  const commands = { executeCommand: (..._args: unknown[]) => promise };
  const native = { spawn: (..._args: unknown[]) => child };
  const inputs = {
    commands,
    childProcess: native,
    document,
    position,
    root: "/fixture",
    source: uri.fsPath,
    cliPath: "/installed/saltbox-lint",
    cliHash: "a".repeat(64),
    productActive: true,
  };
  const command = () =>
    commands.executeCommand("vscode.executeDefinitionProvider", uri, position);
  const args = [
    "query",
    "--operation",
    "definition",
    "--root",
    "/fixture",
    "--stdin-filename",
    uri.fsPath,
    "--offset",
    "4",
  ];
  return {
    inputs,
    commands,
    native,
    document,
    position,
    child,
    promise,
    resolve,
    command,
    args,
  };
}

test("native stderr exposes only a fixed source-owned error stage after close", async () => {
  const fixture = setup();
  const observer = observeFirstDefinition(fixture.inputs);
  try {
    const pending = fixture.command();
    fixture.native.spawn(fixture.inputs.cliPath, fixture.args);
    const data = Buffer.from(
      "saltbox-lint: open source parent secret_path: secret_error\n",
    );
    for (const byte of data)
      fixture.child.stderr.emit("data", Buffer.from([byte]));
    fixture.child.emit("close", 2, null);
    fixture.resolve([]);
    await pending;
    const facts = observer.snapshot();
    assert.equal(
      Reflect.get(facts.child!, "errorStage"),
      "error_source_parent_open",
    );
    assert.doesNotMatch(JSON.stringify(facts), /secret_path|secret_error/);
  } finally {
    observer.dispose();
    fixture.child.stdout.destroy();
    fixture.child.stderr.destroy();
  }
});

test("native stderr rejects encoded controls and line separators across chunk boundaries", async (t) => {
  const prefix = Buffer.from("saltbox-lint: open source parent ");
  const controls = [
    ...Array.from({ length: 32 }, (_, index) => 0x80 + index),
    0x2028,
    0x2029,
  ];
  for (const point of controls) {
    const bytes = Buffer.from(String.fromCodePoint(point));
    for (let split = 0; split <= bytes.length; split++) {
      await t.test(`U+${point.toString(16)} split ${split}`, async () => {
        const fixture = setup();
        const observer = observeFirstDefinition(fixture.inputs);
        try {
          const pending = fixture.command();
          fixture.native.spawn(fixture.inputs.cliPath, fixture.args);
          for (const chunk of [
            prefix,
            bytes.subarray(0, split),
            bytes.subarray(split),
            Buffer.from("secret_path: secret_error\n"),
          ])
            assert.equal(fixture.child.stderr.emit("data", chunk), false);
          fixture.child.emit("close", 2, null);
          fixture.resolve([]);
          await pending;
          const facts = observer.snapshot();
          assert.equal(
            Reflect.get(facts.child!, "errorStage"),
            "error_stage_unknown",
            `U+${point.toString(16)} split ${split}`,
          );
          assert.doesNotMatch(
            JSON.stringify(facts),
            /secret_path|secret_error/,
          );
          assert.equal(fixture.child.stderr.listenerCount("data"), 0);
          assert.equal(fixture.child.stderr.readableFlowing, null);
        } finally {
          observer.dispose();
          fixture.child.stdout.destroy();
          fixture.child.stderr.destroy();
        }
      });
    }
  }
});

test("public request and native wrappers preserve exact receivers, arguments, promise, child and streams", async () => {
  const fixture = setup();
  const commandReceiver = {},
    spawnReceiver = {};
  const commandArguments = [
    "vscode.executeDefinitionProvider",
    fixture.document.uri,
    fixture.position,
  ];
  const options = { env: { SECRET: "secret_env_value" } };
  fixture.commands.executeCommand = function (
    this: unknown,
    ...args: unknown[]
  ) {
    assert.equal(this, commandReceiver);
    assert.deepEqual(args, commandArguments);
    assert.equal(args[1], fixture.document.uri);
    assert.equal(args[2], fixture.position);
    return fixture.promise;
  };
  fixture.native.spawn = function (this: unknown, ...args: unknown[]) {
    assert.equal(this, spawnReceiver);
    assert.equal(args[1], fixture.args);
    assert.equal(args[2], options);
    return fixture.child;
  };
  const commandDescriptor = Object.getOwnPropertyDescriptor(
    fixture.commands,
    "executeCommand",
  );
  const spawnDescriptor = Object.getOwnPropertyDescriptor(
    fixture.native,
    "spawn",
  );
  const stdout = fixture.child.stdout,
    stderr = fixture.child.stderr;
  const observer = observeFirstDefinition(fixture.inputs);
  try {
    assert.equal(
      Reflect.apply(
        fixture.commands.executeCommand,
        commandReceiver,
        commandArguments,
      ),
      fixture.promise,
    );
    assert.equal(
      Reflect.apply(fixture.native.spawn, spawnReceiver, [
        fixture.inputs.cliPath,
        fixture.args,
        options,
      ]),
      fixture.child,
    );
    assert.equal(fixture.child.stdout, stdout);
    assert.equal(fixture.child.stderr, stderr);
    assert.equal(stdout.listenerCount("data"), 0);
    assert.equal(stderr.listenerCount("data"), 0);
    assert.equal(stdout.readableFlowing, null);
    assert.equal(stderr.readableFlowing, null);
    assert.equal(fixture.child.listenerCount("error"), 0);
    const error = new Error("secret_native_error");
    assert.throws(
      () => fixture.child.emit("error", error),
      (actual: unknown) => actual === error,
    );
    let observedChunk: unknown;
    stdout.on("data", (chunk: unknown) => {
      observedChunk = chunk;
    });
    const bytes = Buffer.from("{}");
    assert.equal(stdout.emit("data", bytes), true);
    assert.equal(observedChunk, bytes);
    assert.equal(stderr.emit("data", bytes), false);
    fixture.child.emit("close", 0, null);
    fixture.resolve([]);
    await fixture.promise;
    const facts = observer.snapshot();
    assert.equal(facts.firstResultCount, 0);
    assert.equal(facts.child?.stdoutBytes, bytes.length);
    assert.equal(facts.child?.stderrBytes, bytes.length);
    assert.equal(facts.child?.error, true);
    assert.equal(facts.response.stage, "response_json_object");
  } finally {
    observer.dispose();
    fixture.child.stdout.removeAllListeners("data");
    fixture.child.stdout.destroy();
    fixture.child.stderr.destroy();
  }
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(fixture.commands, "executeCommand"),
    commandDescriptor,
  );
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(fixture.native, "spawn"),
    spawnDescriptor,
  );
  for (const emitter of [fixture.child, stdout, stderr])
    assert.equal(Object.hasOwn(emitter, "emit"), false);
});

test("first eligible mismatched child is retained, later candidates counted, and only allowlisted facts emitted after restoration", async () => {
  const fixture = setup();
  const originalCommand = fixture.commands.executeCommand,
    originalSpawn = fixture.native.spawn;
  const observer = observeFirstDefinition(fixture.inputs);
  const original = new Error("original definition count failure");
  const lines: string[] = [];
  await assert.rejects(
    withFirstDefinitionObservation(
      observer,
      async () => {
        const pending = fixture.command();
        fixture.native.spawn(
          fixture.inputs.cliPath,
          fixture.args.map((arg) =>
            arg === "/fixture" ? "secret_wrong_root" : arg,
          ),
        );
        fixture.native.spawn(fixture.inputs.cliPath, fixture.args);
        const response = {
          schema_version: 1,
          operation: "definition",
          root: "secret_wrong_root",
          path: "secret_wrong_path",
          source_sha256: "secret_invalid_hash",
          offset: "secret_wrong_offset",
          locations: [{ text: "secret_location_value" }],
          declarations: [
            { name: "secret_declaration_value", value: "secret_literal_value" },
          ],
          completions: [],
          target_hashes: { secret_target_name: "secret_target_hash" },
          dependencies: {
            sources: [{ files: [{ path: "secret_dependency_name" }] }],
          },
          reasons: ["secret_reason"],
          env: "secret_env_value",
          stdin: "secret_source_value",
        };
        fixture.child.stdout.emit(
          "data",
          Buffer.from(JSON.stringify(response)),
        );
        fixture.child.stderr.emit("data", Buffer.from("secret_stderr"));
        fixture.child.emit("close", 0, null);
        fixture.document.version++;
        fixture.document.isDirty = true;
        fixture.resolve([]);
        await pending;
        await fixture.command();
        throw original;
      },
      (line) => {
        assert.equal(fixture.commands.executeCommand, originalCommand);
        assert.equal(fixture.native.spawn, originalSpawn);
        assert.equal(Object.hasOwn(fixture.child.stdout, "emit"), false);
        lines.push(line);
      },
    ),
    (error: unknown) => error === original,
  );
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes("secret_"));
  assert.ok(Buffer.byteLength(lines[0]) < 16 * 1024);
  const facts = JSON.parse(
    lines[0].slice("SALTBOX_FIRST_DEFINITION_FAILURE ".length),
  );
  assert.equal(facts.calls, 2);
  assert.equal(facts.candidates, 2);
  assert.equal(facts.matches, 1);
  assert.equal(facts.child.rootMatches, false);
  assert.equal(facts.response.rootMatches, false);
  assert.equal(facts.response.hashMatches, false);
  assert.equal(facts.response.declarations, 1);
  assert.equal(facts.response.dependencyFiles, 1);
  assert.equal(facts.settledDocument.versionMatches, false);
  assert.equal(facts.failureDocument.dirty, true);
  assert.equal(facts.cancellation, "provider_token_unavailable");
  fixture.child.stdout.destroy();
  fixture.child.stderr.destroy();
});

test("synchronous exceptions and rejected promises retain their identities; observation and logger faults preserve the assertion", async () => {
  for (const kind of ["throw", "reject"]) {
    const fixture = setup(),
      original = new Error("secret_command_error");
    const rejected = Promise.reject(original);
    // Handle the intentionally created rejection even in the synchronous case.
    await rejected.catch(() => {});
    fixture.commands.executeCommand = () => {
      if (kind === "throw") throw original;
      return rejected;
    };
    const observer = observeFirstDefinition(fixture.inputs);
    if (kind === "throw")
      assert.throws(fixture.command, (error: unknown) => error === original);
    else {
      assert.equal(fixture.command(), rejected);
      await assert.rejects(rejected, (error: unknown) => error === original);
    }
    const failure = new Error("original assertion");
    observer.snapshot = () => {
      throw new Error("secret_observer_error");
    };
    await assert.rejects(
      withFirstDefinitionObservation(
        observer,
        async () => {
          throw failure;
        },
        () => {
          throw new Error("secret_logger_error");
        },
      ),
      (error: unknown) => error === failure,
    );
    fixture.child.stdout.destroy();
    fixture.child.stderr.destroy();
  }
});

test("a valid unexpected response digest emits equality only and retains captured expected digests", async () => {
  const fixture = setup();
  const unexpectedDigest = "b".repeat(64);
  const expectedDigest = createHash("sha256")
    .update(fixture.document.getText())
    .digest("hex");
  const observer = observeFirstDefinition(fixture.inputs);
  const original = new Error("original assertion");
  const messages: string[] = [];
  await assert.rejects(
    withFirstDefinitionObservation(
      observer,
      async () => {
        const pending = fixture.command();
        fixture.native.spawn(fixture.inputs.cliPath, fixture.args);
        fixture.child.stdout.emit(
          "data",
          Buffer.from(JSON.stringify({ source_sha256: unexpectedDigest })),
        );
        fixture.child.emit("close", 0, null);
        fixture.resolve([]);
        await pending;
        throw original;
      },
      (line) => messages.push(line),
    ),
    (error: unknown) => error === original,
  );
  assert.equal(messages.length, 1);
  assert.ok(!messages[0].includes(unexpectedDigest));
  const facts = JSON.parse(
    messages[0].slice("SALTBOX_FIRST_DEFINITION_FAILURE ".length),
  );
  assert.equal(facts.response.stage, "response_json_object");
  assert.equal(facts.response.hashMatches, false);
  assert.equal(Object.hasOwn(facts.response, "sourceHash"), false);
  assert.equal(facts.sourceHash, expectedDigest);
  assert.equal(facts.cliHash, fixture.inputs.cliHash);
  fixture.child.stdout.destroy();
  fixture.child.stderr.destroy();
});

test("expected path availability is explicit without echoing unknown or rejected paths", async () => {
  for (const [value, available] of [
    [undefined, false],
    [null, false],
    [7, false],
    ["", false],
    ["rejected_path_" + "x".repeat(4097), false],
    ["rejected_path_\n", false],
    ["rejected_path_\u0000", false],
    ["x".repeat(4096), true],
    ['unicode_😀_"_\\_path', true],
  ] as const) {
    for (const field of ["root", "source", "cliPath"] as const) {
      for (const platform of ["linux", "win32"] as const) {
        const fixture = setup();
        Reflect.set(fixture.inputs, field, value);
        const observer = observeFirstDefinition({
          ...fixture.inputs,
          platform,
        });
        const original = new Error("original assertion");
        const messages: string[] = [];
        await assert.rejects(
          withFirstDefinitionObservation(
            observer,
            async () => {
              throw original;
            },
            (line) => messages.push(line),
          ),
          (error: unknown) => error === original,
        );
        assert.equal(messages.length, 1);
        assert.ok(Buffer.byteLength(messages[0], "utf8") <= 16 * 1024);
        assert.ok(!messages[0].includes("rejected_path_"));
        const facts = JSON.parse(
          messages[0].slice("SALTBOX_FIRST_DEFINITION_FAILURE ".length),
        );
        assert.equal(facts.stage, "original_assertion_rejected");
        assert.equal(
          facts[field + "Availability"],
          available ? "path_available" : "path_unavailable",
        );
        assert.equal(facts[field], available ? value : undefined);
        fixture.child.stdout.destroy();
        fixture.child.stderr.destroy();
      }
    }
  }
});

test("response and candidate path comparisons classify unavailable identities without echoing values", async () => {
  for (const [value, available] of [
    [undefined, false],
    [null, false],
    [7, false],
    ["", false],
    ["secret_path_" + "x".repeat(4097), false],
    ["secret_path_\n", false],
    ["secret_path_\u0000", false],
    ["x".repeat(4096), true],
    ['secret_path_😀_"_\\', true],
  ] as const) {
    const fixture = setup();
    const observer = observeFirstDefinition(fixture.inputs);
    const original = new Error("original assertion");
    const messages: string[] = [];
    await assert.rejects(
      withFirstDefinitionObservation(
        observer,
        async () => {
          const pending = fixture.command();
          fixture.native.spawn(
            fixture.inputs.cliPath,
            fixture.args.map((arg) =>
              arg === fixture.inputs.root || arg === fixture.inputs.source
                ? value
                : arg,
            ),
          );
          fixture.child.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                root: value,
                path: value,
                dependencies: { root: value },
              }),
            ),
          );
          fixture.child.emit("close", 0, null);
          fixture.resolve([]);
          await pending;
          throw original;
        },
        (line) => messages.push(line),
      ),
      (error: unknown) => error === original,
    );
    assert.equal(messages.length, 1);
    assert.ok(Buffer.byteLength(messages[0], "utf8") <= 16 * 1024);
    assert.ok(!messages[0].includes("secret_path_"));
    const facts = JSON.parse(
      messages[0].slice("SALTBOX_FIRST_DEFINITION_FAILURE ".length),
    );
    const availability = available ? "path_available" : "path_unavailable";
    assert.equal(facts.child.rootAvailability, availability);
    assert.equal(facts.child.sourceAvailability, availability);
    assert.equal(facts.child.cliPathAvailability, "path_available");
    assert.equal(facts.child.rootMatches, false);
    assert.equal(facts.child.sourceMatches, false);
    assert.equal(facts.response.stage, "response_json_object");
    assert.equal(facts.response.rootAvailability, availability);
    assert.equal(facts.response.pathAvailability, availability);
    assert.equal(facts.response.dependencyRootAvailability, availability);
    assert.equal(facts.response.rootMatches, false);
    assert.equal(facts.response.pathMatches, false);
    assert.equal(facts.response.dependencyRootMatches, false);
    fixture.child.stdout.destroy();
    fixture.child.stderr.destroy();
  }
});

test("capture bounds and malformed output yield fixed stages without raw payloads", async () => {
  for (const [bytes, stage] of [
    [Buffer.alloc(256 * 1024 + 1, "x"), "response_capture_truncated"],
    [Buffer.from([0xff]), "response_utf8_invalid"],
    [Buffer.from("secret_not_json"), "response_json_invalid"],
    [Buffer.from("[]"), "response_json_not_object"],
  ] as const) {
    const fixture = setup();
    fixture.inputs.root = "x".repeat(4097);
    fixture.inputs.cliHash = "secret_invalid_cli_digest";
    const observer = observeFirstDefinition(fixture.inputs);
    const pending = fixture.command();
    fixture.native.spawn(fixture.inputs.cliPath, fixture.args);
    fixture.child.stdout.emit("data", bytes);
    fixture.child.emit("close", 0, null);
    fixture.resolve([]);
    await pending;
    const facts = observer.snapshot();
    assert.equal(facts.response.stage, stage);
    assert.equal(facts.root, undefined);
    assert.equal(facts.rootAvailability, "path_unavailable");
    assert.equal(facts.cliHash, undefined);
    assert.ok(!JSON.stringify(facts).includes("secret_"));
    observer.dispose();
    fixture.child.stdout.destroy();
    fixture.child.stderr.destroy();
  }
});

test("success is silent, disposal is repeatable, and late promise or child events cannot retain facts", async () => {
  const fixture = setup();
  for (let round = 0; round < 2; round++) {
    const observer = observeFirstDefinition(fixture.inputs);
    assert.equal(
      await withFirstDefinitionObservation(
        observer,
        async () => 7,
        () => {
          assert.fail("success emitted evidence");
        },
      ),
      7,
    );
    observer.dispose();
  }
  const observer = observeFirstDefinition(fixture.inputs);
  const pending = fixture.command();
  fixture.native.spawn(fixture.inputs.cliPath, fixture.args);
  observer.dispose();
  fixture.document.getText = () => {
    throw new Error("late document access");
  };
  fixture.resolve([{}, {}, {}]);
  await pending;
  fixture.child.emit("close", 0, null);
  const facts = observer.snapshot();
  assert.equal(facts.commandStage, "request_entered");
  assert.equal(facts.firstResultCount, undefined);
  assert.equal(facts.child?.closed, false);
  fixture.child.stdout.destroy();
  fixture.child.stderr.destroy();
});

test("an unmatched command or CLI cannot create a fabricated child observation", async () => {
  const fixture = setup();
  const observer = observeFirstDefinition(fixture.inputs);
  const unrelated = fixture.commands.executeCommand(
    "unrelated",
    fixture.document.uri,
    fixture.position,
  );
  fixture.native.spawn(fixture.inputs.cliPath, fixture.args);
  const pending = fixture.command();
  fixture.native.spawn("/other/cli", fixture.args);
  fixture.native.spawn(fixture.inputs.cliPath, ["check"]);
  fixture.resolve([]);
  await Promise.all([pending, unrelated]);
  const facts = observer.snapshot();
  assert.equal(facts.calls, 1);
  assert.equal(facts.candidates, 0);
  assert.equal(facts.child, undefined);
  assert.equal(facts.response.stage, "response_close_not_observed");
  observer.dispose();
  fixture.child.stdout.destroy();
  fixture.child.stderr.destroy();
});

test("Windows known canonical and short executable spellings tolerate drive case without admitting other executables", async () => {
  const fixture = setup();
  const observer = observeFirstDefinition({
    ...fixture.inputs,
    cliPath: "C:\\PROGRA~1\\saltbox\\saltbox-lint.exe",
    cliCanonicalPath: "C:\\Program Files\\saltbox\\saltbox-lint.exe",
    platform: "win32",
  });
  const pending = fixture.command();
  fixture.native.spawn("c:\\unrelated\\saltbox-lint.exe", fixture.args);
  fixture.native.spawn(
    "\\\\?\\c:\\program files\\saltbox\\saltbox-lint.exe",
    fixture.args,
  );
  fixture.resolve([]);
  await pending;
  const facts = observer.snapshot();
  assert.equal(facts.candidates, 1);
  assert.equal(facts.matches, 1);
  assert.equal(facts.child?.cliRawPathMatches, false);
  observer.dispose();
  fixture.child.stdout.destroy();
  fixture.child.stderr.destroy();
});

test("native synchronous spawn failure remains visible without replacing its error", async () => {
  const fixture = setup(),
    original = new Error("secret_spawn_error");
  fixture.native.spawn = () => {
    throw original;
  };
  const observer = observeFirstDefinition(fixture.inputs);
  const pending = fixture.command();
  assert.throws(
    () => fixture.native.spawn(fixture.inputs.cliPath, fixture.args),
    (error: unknown) => error === original,
  );
  fixture.resolve([]);
  await pending;
  const facts = observer.snapshot();
  assert.equal(facts.candidates, 1);
  assert.equal(facts.child?.spawnThrew, true);
  assert.ok(!JSON.stringify(facts).includes("secret_"));
  observer.dispose();
  fixture.child.stdout.destroy();
  fixture.child.stderr.destroy();
});

test("the first native child of an existing later poll remains observable after an initial empty public result", async () => {
  const fixture = setup();
  const observer = observeFirstDefinition(fixture.inputs);
  const first = fixture.command();
  fixture.resolve([]);
  await first;
  assert.equal(observer.snapshot().candidates, 0);
  const second = fixture.command();
  fixture.native.spawn(fixture.inputs.cliPath, fixture.args);
  fixture.child.stdout.emit("data", Buffer.from("{}"));
  fixture.child.emit("close", 0, null);
  await second;
  const facts = observer.snapshot();
  assert.equal(facts.calls, 2);
  assert.equal(facts.firstResultCount, 0);
  assert.equal(facts.child?.publicAttempt, 2);
  assert.equal(facts.response.stage, "response_json_object");
  observer.dispose();
  fixture.child.stdout.destroy();
  fixture.child.stderr.destroy();
});

test("total failure output remains bounded even when allowed paths need JSON escaping", async () => {
  const fixture = setup();
  const observer = observeFirstDefinition({
    ...fixture.inputs,
    root: "\\".repeat(4096),
    source: "\\".repeat(4096),
    cliPath: "\\".repeat(4096),
  });
  const original = new Error("original assertion");
  const messages: string[] = [];
  await assert.rejects(
    withFirstDefinitionObservation(
      observer,
      async () => {
        throw original;
      },
      (line) => {
        messages.push(line);
      },
    ),
    (error: unknown) => error === original,
  );
  assert.equal(messages.length, 1);
  assert.ok(Buffer.byteLength(messages[0]) <= 16 * 1024);
  assert.match(messages[0], /observation_output_truncated/);
  fixture.child.stdout.destroy();
  fixture.child.stderr.destroy();
});

test("real native output retains ordinary stream behavior and response identity metadata", async () => {
  const fixture = setup();
  const temporary = await mkdtemp(
    join(tmpdir(), "saltbox-definition-observer-"),
  );
  const response = {
    schema_version: 1,
    operation: "definition",
    root: "/fixture",
    path: "source.yml",
    source_sha256: createHash("sha256")
      .update(fixture.document.getText())
      .digest("hex"),
    offset: 4,
    locations: [{}, {}, {}],
    declarations: [{}, {}, {}],
    completions: [],
    target_hashes: {},
    dependencies: { sources: [{ files: [] }] },
  };
  await writeFile(
    join(temporary, "query"),
    "process.stdout.write(" +
      JSON.stringify(JSON.stringify(response)) +
      ");process.stderr.write('private stderr');\n",
  );
  const native = { spawn };
  const observer = observeFirstDefinition({
    ...fixture.inputs,
    childProcess: native,
    cliPath: process.execPath,
  });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const pending = fixture.command();
    child = native.spawn(process.execPath, fixture.args, {
      cwd: temporary,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    child.stdout!.on("data", (data: Buffer) => {
      stdout.push(data);
    });
    child.stderr!.on("data", (data: Buffer) => {
      stderr.push(data);
    });
    await new Promise<void>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("native observation fixture failed"));
      });
    });
    fixture.resolve([{}, {}, {}]);
    await pending;
    assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString()), response);
    assert.equal(Buffer.concat(stderr).toString(), "private stderr");
    const facts = observer.snapshot();
    assert.equal(facts.child?.closed, true);
    assert.equal(facts.child?.exitCode, 0);
    assert.equal(facts.response.stage, "response_json_object");
    assert.equal(
      "hashMatches" in facts.response && facts.response.hashMatches,
      true,
    );
    assert.equal(
      "pathMatches" in facts.response && facts.response.pathMatches,
      true,
    );
    assert.equal(facts.firstResultCount, 3);
  } finally {
    observer.dispose();
    await rm(temporary, { recursive: true, force: true });
    fixture.child.stdout.destroy();
    fixture.child.stderr.destroy();
  }
  assert.equal(child?.exitCode, 0);
});
