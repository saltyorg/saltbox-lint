import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export interface InstalledProduct {
  id: string;
  extensionPath: string;
  version: unknown;
}

function confined(root: string, filename: string, label: string): void {
  const canonicalRoot = realpathSync.native(root);
  const canonicalFilename = realpathSync.native(filename);
  const path = relative(canonicalRoot, canonicalFilename);
  assert.ok(
    path && !path.startsWith("..") && !isAbsolute(path),
    `${label} must belong to its isolated installation: ${JSON.stringify({
      root,
      filename,
      canonicalRoot,
      canonicalFilename,
      relative: path,
    }).slice(0, 4096)}`,
  );
}

/** Verify an installation; active behavior also requires the actual loaded product. */
export function verifyInstalledProduct(
  environment: Readonly<NodeJS.ProcessEnv>,
  product: InstalledProduct | undefined,
  platform: NodeJS.Platform = process.platform,
): "development" | "loaded" | "disabled" | "restricted" {
  if (!environment.SALTBOX_TEST_VSIX) return "development";
  const disabled = environment.SALTBOX_TEST_DISABLED === "1";
  const restricted = environment.SALTBOX_TEST_UNTRUSTED === "1";
  assert.ok(
    product || disabled || restricted,
    "VSIX product must actually be installed and loaded",
  );
  if (product) assert.equal(product.id, "saltyorg.saltbox-lint");
  const expectedPath = environment.SALTBOX_TEST_EXPECTED_PRODUCT_PATH;
  const expectedVersion = environment.SALTBOX_TEST_EXPECTED_PRODUCT_VERSION;
  const expectedHash = environment.SALTBOX_TEST_EXPECTED_CLI_SHA256;
  const extensions = environment.SALTBOX_TEST_EXTENSIONS_DIR;
  assert.ok(
    expectedPath && expectedVersion && expectedHash && extensions,
    "installed artifact expectations must be supplied by the launcher",
  );
  const installation = product?.extensionPath ?? expectedPath;
  confined(extensions, installation, "Loaded product");
  assert.equal(
    realpathSync.native(installation),
    realpathSync.native(expectedPath),
    "loaded product must be the exact installed package",
  );
  const manifest: { publisher?: unknown; name?: unknown; version?: unknown } =
    JSON.parse(readFileSync(join(installation, "package.json"), "utf8"));
  assert.equal(manifest.publisher, "saltyorg");
  assert.equal(manifest.name, "saltbox-lint");
  assert.equal(
    manifest.version,
    expectedVersion,
    "installed package version must match the tested VSIX",
  );
  if (product)
    assert.equal(
      product.version,
      expectedVersion,
      "loaded product version must match the tested VSIX",
    );
  const backend = join(
    installation,
    "bin",
    "saltbox-lint" + (platform === "win32" ? ".exe" : ""),
  );
  assert.ok(
    environment.SALTBOX_TEST_INSTALLED_CLI_PATH,
    "verified backend path must be supplied by the launcher",
  );
  assert.equal(
    realpathSync.native(environment.SALTBOX_TEST_INSTALLED_CLI_PATH),
    realpathSync.native(backend),
    "controller backend must be the exact packaged executable",
  );
  confined(installation, backend, "Loaded backend");
  assert.equal(
    createHash("sha256").update(readFileSync(backend)).digest("hex"),
    expectedHash,
    "loaded backend bytes must match installation preflight",
  );
  return disabled ? "disabled" : restricted ? "restricted" : "loaded";
}
