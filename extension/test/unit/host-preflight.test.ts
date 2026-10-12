import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

test("active-project installation identity accepts a verified directory alias or drive spelling and rejects another package", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "saltbox-active-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extensions = join(root, "extensions");
  const installation = join(extensions, "installed");
  const other = join(extensions, "other");
  const aliasedExtensions = join(root, "extensions-alias");
  const bytes = "independently tested package backend";
  const manifest = JSON.stringify({
    publisher: "saltyorg",
    name: "saltbox-lint",
    version: "1.2.3",
  });
  for (const folder of [installation, other]) {
    await mkdir(join(folder, "bin"), { recursive: true });
    await writeFile(join(folder, "bin", "saltbox-lint"), bytes);
    await writeFile(join(folder, "package.json"), manifest);
  }
  await symlink(extensions, aliasedExtensions, "junction");
  const canonical = await realpath(installation);
  const publicPath =
    process.platform === "win32"
      ? canonical[0].toLowerCase() + canonical.slice(1)
      : canonical;
  const environment = {
    SALTBOX_TEST_VSIX: "tested.vsix",
    SALTBOX_TEST_EXTENSIONS_DIR: aliasedExtensions,
    SALTBOX_TEST_EXPECTED_PRODUCT_PATH: join(aliasedExtensions, "installed"),
    SALTBOX_TEST_EXPECTED_PRODUCT_VERSION: "1.2.3",
    SALTBOX_TEST_INSTALLED_CLI_PATH: join(
      aliasedExtensions,
      "installed",
      "bin",
      "saltbox-lint",
    ),
    SALTBOX_TEST_EXPECTED_CLI_SHA256: createHash("sha256")
      .update(bytes)
      .digest("hex"),
  };
  const product = {
    id: "saltyorg.saltbox-lint",
    extensionPath: publicPath,
    version: "1.2.3",
  };
  assert.equal(product.extensionPath.startsWith(aliasedExtensions), false);
  assert.equal(verifyInstalledProduct(environment, product, "linux"), "loaded");
  assert.throws(
    () =>
      verifyInstalledProduct(
        environment,
        { ...product, extensionPath: other },
        "linux",
      ),
    /exact installed package/,
  );
  await writeFile(
    join(installation, "bin", "saltbox-lint"),
    "same-version wrong backend",
  );
  assert.throws(
    () => verifyInstalledProduct(environment, product, "linux"),
    /backend bytes/,
  );
});
