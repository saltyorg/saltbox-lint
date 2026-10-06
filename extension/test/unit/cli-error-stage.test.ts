import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { observeCLIErrorStage } from "../host/cli-error-stage.ts";

const unknown = "error_stage_unknown";
const line = "saltbox-lint: open source parent secret_path: secret_error 🦀\n";

test("each classifier prefix belongs to the current Go error boundary", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const literals = [
    "cmd/query.go",
    "lint/query.go",
    "lint/discovery.go",
  ].flatMap((name) =>
    [
      ...readFileSync(resolve(root, name), "utf8").matchAll(
        /fmt\.Errorf\("([^"\n]*)"/gu,
      ),
    ].map((match) => "saltbox-lint: " + match[1]),
  );
  literals.push(
    ...[
      ...readFileSync(
        resolve(root, "editor_process_windows.go"),
        "utf8",
      ).matchAll(/fmt\.Errorf\("([^"\n]*)"/gu),
    ].map((match) => match[1]),
  );
  const classifier = readFileSync(
    resolve(import.meta.dirname, "../host/cli-error-stage.ts"),
    "utf8",
  );
  const rules = [
    ...classifier.matchAll(
      /\[\s*("(?:[^"\\]|\\.)*"),\s*"(error_[a-z_]+)"\s*,?\s*\]/gu,
    ),
  ];
  assert.equal(rules.length, 41);
  for (const rule of rules) {
    const prefix: unknown = JSON.parse(rule[1]);
    assert.ok(typeof prefix === "string");
    assert.equal(
      literals.some((literal) => {
        const variable = literal.indexOf("%");
        return (
          prefix ===
          (variable < 0 ? literal + "\n" : literal.slice(0, variable))
        );
      }),
      true,
      rule[2],
    );
    const observer = observeCLIErrorStage();
    const message = prefix.endsWith("\n")
      ? prefix
      : prefix + "secret_path: secret_error 🦀\n";
    for (const byte of Buffer.from(message))
      observer.observe(Buffer.from([byte]));
    assert.equal(observer.stage(true, 2), rule[2]);
    assert.equal(observer.stage(false, 2), unknown);
    assert.equal(observer.stage(true, 0), unknown);
    assert.equal(observer.stage(true, null), unknown);
    observer.dispose();
    assert.equal(observer.stage(true, 2), unknown);
  }
});

test("classification is independent of chunk boundaries and retains no opaque tail", () => {
  const bytes = Buffer.from(line);
  for (let split = 0; split <= bytes.length; split++) {
    const observer = observeCLIErrorStage();
    observer.observe(bytes.subarray(0, split));
    observer.observe(bytes.subarray(split));
    assert.equal(observer.stage(true, 2), "error_source_parent_open");
    assert.doesNotMatch(JSON.stringify(observer), /secret_path|secret_error/);
  }
});

test("valid Unicode boundaries remain eligible opaque tail content", () => {
  for (const point of [
    0x7e, 0xa0, 0xa1, 0x7ff, 0x800, 0x2027, 0x202f, 0x2030, 0x20a8, 0xe028,
    0xe029, 0x10000, 0x1f980, 0x10ffff,
  ]) {
    const bytes = Buffer.from(
      "saltbox-lint: open source parent " +
        String.fromCodePoint(point) +
        "secret_path: secret_error\n",
    );
    for (let split = 0; split <= bytes.length; split++) {
      const observer = observeCLIErrorStage();
      observer.observe(bytes.subarray(0, split));
      observer.observe(bytes.subarray(split));
      assert.equal(observer.stage(true, 2), "error_source_parent_open");
      assert.doesNotMatch(JSON.stringify(observer), /secret_path|secret_error/);
      observer.dispose();
    }
  }
});

test("unavailable and malformed stderr never acquire an invented stage", () => {
  const cases: unknown[][] = [
    [],
    [undefined],
    [null],
    [line],
    [new DataView(new ArrayBuffer(1))],
    [Buffer.from("private stderr\n")],
    [Buffer.from("prefix " + line)],
    [Buffer.from(line.trimEnd())],
    [Buffer.from(line + "another line\n")],
    [Buffer.from(line.replace("\n", "\r\n"))],
    [Buffer.from(line.replace("secret_error", "\u0000"))],
    [Buffer.from(line.replace("secret_error", "\u007f"))],
    [Buffer.from("saltbox-lint: open source parent \n")],
    [Buffer.from("saltbox-lint: query snapshot exceeds 16 MiB extra\n")],
    [Buffer.from("saltbox-lint: query snapshot exceeds 16 MiB\n"), undefined],
    [
      Buffer.from("saltbox-lint: open source parent "),
      Buffer.from([0xe2, 0x82]),
    ],
  ];
  for (const bytes of [
    [0x80],
    [0xc0, 0x80],
    [0xc2, 0x7f],
    [0xe0, 0x80, 0x80],
    [0xed, 0xa0, 0x80],
    [0xf0, 0x80, 0x80, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xf5, 0x80, 0x80, 0x80],
  ])
    cases.push([
      Buffer.from("saltbox-lint: open source parent "),
      Buffer.from(bytes),
      Buffer.from("\n"),
    ]);
  for (const chunks of cases) {
    const observer = observeCLIErrorStage();
    for (const chunk of chunks) observer.observe(chunk);
    assert.equal(observer.stage(true, 2), unknown);
  }
});

test("stderr classification has an exact bound independent of the product output limit", () => {
  const prefix = "saltbox-lint: open source parent ";
  for (const extra of [0, 1]) {
    const observer = observeCLIErrorStage();
    observer.observe(Buffer.from(prefix));
    observer.observe(
      Buffer.alloc(256 * 1024 - prefix.length - 1 + extra, 0x78),
    );
    observer.observe(Buffer.from("\n"));
    assert.equal(
      observer.stage(true, 2),
      extra ? unknown : "error_source_parent_open",
    );
  }
});
