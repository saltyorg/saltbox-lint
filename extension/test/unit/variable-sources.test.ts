import assert from "node:assert/strict";
import { test } from "node:test";
import { variableDeclarationPath } from "../../src/variable-sources.ts";

test("declaration paths include defaults, vars and inventory but exclude tasks and user overrides", () => {
  for (const file of [
    "roles/example/defaults/main.yml",
    "resources/roles/example/vars/nested/main.yaml",
    "roles/example/defaults/main.YML",
    "group_vars/all.yml",
    "host_vars/remote.yml",
    "inventories/prod/group_vars/all.yml",
    "inventory/prod/host_vars/remote.yml",
    "inventory.yml",
    "inventory.yaml",
    "vars.yml",
    "vars.yaml",
  ])
    assert.equal(variableDeclarationPath(file), true, file);
  for (const file of [
    "roles/example/tasks/main.yml",
    "roles/example/handlers/main.yml",
    "roles/example/templates/data.yml.j2",
    "tasks/main.yml",
    "localhost.yml",
    "inventories/host_vars/localhost.yml",
    "host_vars/localhost.yml",
    "inventory/prod/tasks/main.yml",
    "roles/example/defaults/data.txt",
    "inventory.yaml.j2",
  ])
    assert.equal(variableDeclarationPath(file), false, file);
});
