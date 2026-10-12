import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHostProfile, hostProfileNames } from "../host/host-profile.ts";
import { verifyInstalledProduct } from "../host/host-preflight.ts";

for (const name of hostProfileNames)
  test(`controller dispatch accepts ${name}`, () => {
    assert.equal(getHostProfile({ SALTBOX_TEST_HOST_MODE: name }), name);
  });

test("controller dispatch rejects missing or unrecognized profiles", () => {
  for (const name of [undefined, "", "unexpected", "Normal"]) {
    assert.throws(
      () => getHostProfile({ SALTBOX_TEST_HOST_MODE: name }),
      /Unknown host profile/,
    );
  }
});

test("loaded package preflight detects wrong path, version, backend, and incomplete identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "saltbox-preflight-"));
  const extensions = join(root, "extensions");
  const installed = join(extensions, "installed");
  const other = join(extensions, "other");
  const backend = join(installed, "bin", "saltbox-lint");
  try {
    await mkdir(join(installed, "bin"), { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(backend, "tested backend");
    await writeFile(
      join(installed, "package.json"),
      JSON.stringify({
        publisher: "saltyorg",
        name: "saltbox-lint",
        version: "1.2.3",
      }),
    );
    const environment = {
      SALTBOX_TEST_VSIX: "tested.vsix",
      SALTBOX_TEST_EXTENSIONS_DIR: extensions,
      SALTBOX_TEST_EXPECTED_PRODUCT_PATH: installed,
      SALTBOX_TEST_EXPECTED_PRODUCT_VERSION: "1.2.3",
      SALTBOX_TEST_INSTALLED_CLI_PATH: backend,
      SALTBOX_TEST_EXPECTED_CLI_SHA256: createHash("sha256")
        .update("tested backend")
        .digest("hex"),
    };
    const product = {
      id: "saltyorg.saltbox-lint",
      extensionPath: installed,
      version: "1.2.3",
    };
    assert.equal(
      verifyInstalledProduct(environment, product, "linux"),
      "loaded",
    );
    assert.equal(
      verifyInstalledProduct(
        { ...environment, SALTBOX_TEST_DISABLED: "1" },
        undefined,
        "linux",
      ),
      "disabled",
    );
    assert.equal(
      verifyInstalledProduct(
        { ...environment, SALTBOX_TEST_UNTRUSTED: "1" },
        undefined,
        "linux",
      ),
      "restricted",
    );
    for (const version of [undefined, null])
      assert.throws(
        () =>
          verifyInstalledProduct(environment, { ...product, version }, "linux"),
        /loaded product version/,
      );
    assert.throws(
      () => verifyInstalledProduct(environment, undefined, "linux"),
      /actually be installed/,
    );
    assert.throws(
      () =>
        verifyInstalledProduct(
          environment,
          { ...product, extensionPath: other },
          "linux",
        ),
      /exact installed package/,
    );
    assert.throws(
      () =>
        verifyInstalledProduct(
          environment,
          { ...product, extensionPath: root },
          "linux",
        ),
      /isolated installation/,
    );
    assert.throws(
      () =>
        verifyInstalledProduct(
          environment,
          { ...product, version: "1.2.4" },
          "linux",
        ),
      /version/,
    );
    assert.throws(
      () =>
        verifyInstalledProduct(
          { ...environment, SALTBOX_TEST_EXPECTED_CLI_SHA256: undefined },
          product,
          "linux",
        ),
      /expectations/,
    );
    await writeFile(backend, "different backend");
    assert.throws(
      () => verifyInstalledProduct(environment, product, "linux"),
      /backend bytes/,
    );
    await rm(backend);
    const outside = join(root, "other-backend");
    await writeFile(outside, "tested backend");
    await symlink(outside, backend);
    assert.throws(
      () => verifyInstalledProduct(environment, product, "linux"),
      /Loaded backend/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
