import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRegistry } from "../../src/protocol.ts";
const rule = {
  id: "a-rule",
  summary: "Summary",
  explanation: "Explanation",
  source_kinds: ["generic"],
  scope: "file",
  good_example: "v: good",
  bad_example: "v: bad",
  fixable: true,
};
test("registry validates schema, ordered unique IDs and complete metadata", () => {
  const wire = (rules: unknown[] = [rule], schema_version = 1) =>
    JSON.stringify({ schema_version, rules });
  assert.deepEqual(parseRegistry(wire()), [rule]);
  for (const invalid of [
    wire([rule], 2),
    wire([rule, rule]),
    wire([{ ...rule, id: "command:run" }]),
    wire([{ ...rule, source_kinds: [] }]),
    wire([{ ...rule, explanation: "" }]),
    wire([{ ...rule, fixable: "yes" }]),
  ])
    assert.throws(() => parseRegistry(invalid));
});
