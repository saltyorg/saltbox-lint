// @ts-check
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  integrityOf,
  parsePin,
  pinFile,
  setupNpm,
  tarballURL,
} from "../../tools/setup-npm.mjs";

/** @param {(root:string)=>Promise<void>} body */
async function withRoot(body) {
  const base = process.env.SALTBOX_TEST_REPOSITORY_BASE ?? tmpdir();
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "saltbox-setup-npm-"));
  try {
    await body(root);
    assert.deepEqual(await readdir(root), [], "bootstrap must remove inputs");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const bytes = new TextEncoder().encode("verified npm tarball");
const pin = { version: "1.2.3", integrity: integrityOf(bytes) };

test("committed npm pin is exact and matches packageManager", async () => {
  const committed = parsePin(await readFile(pinFile, "utf8"));
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.packageManager, `npm@${committed.version}`);
  assert.equal(
    tarballURL(committed.version),
    `https://registry.npmjs.org/npm/-/npm-${committed.version}.tgz`,
  );
});

test("npm pin rejects ranges, other digests and extra fields", () => {
  const integrity = pin.integrity;
  for (const value of [
    { version: "^1.2.3", integrity },
    { version: "1.2", integrity },
    { version: "1.2.3", integrity: "sha1-AAAA" },
    { version: "1.2.3", integrity: `${integrity} sha512-x` },
    { version: "1.2.3", integrity, tarball: "https://example.test/npm.tgz" },
  ])
    assert.throws(() => parsePin(JSON.stringify(value)));
});

test("verified tarball is installed offline from a removed private copy", async () => {
  await withRoot(async (root) => {
    /** @type {{url?:string, installed?:Uint8Array}} */
    const seen = {};
    const result = await setupNpm(pin, {
      tempRoot: root,
      download: (url) => {
        seen.url = url;
        return Promise.resolve(bytes);
      },
      install: (tarball) => {
        // Synchronous like the real installer; the file exists until return.
        seen.installed = new Uint8Array(readFileSync(tarball));
      },
      installedVersion: () => "1.2.3",
    });
    assert.deepEqual(result, pin);
    assert.equal(seen.url, tarballURL("1.2.3"));
    assert.deepEqual(seen.installed, bytes);
  });
});

test("integrity mismatch never reaches the installer", async () => {
  await withRoot(async (root) => {
    let installed = false;
    await assert.rejects(
      setupNpm(pin, {
        tempRoot: root,
        download: () => Promise.resolve(new TextEncoder().encode("tampered")),
        install: () => {
          installed = true;
        },
        installedVersion: () => "1.2.3",
      }),
      /integrity mismatch/,
    );
    assert.equal(installed, false);
  });
});

test("installer failure and unexpected installed version fail after cleanup", async () => {
  await withRoot(async (root) => {
    /** @type {string|undefined} */
    let tarball;
    await assert.rejects(
      setupNpm(pin, {
        tempRoot: root,
        download: () => Promise.resolve(bytes),
        install: (path) => {
          tarball = path;
          throw new Error("install failed");
        },
        installedVersion: () => "1.2.3",
      }),
      /install failed/,
    );
    assert.ok(tarball && !existsSync(tarball));
  });
  await withRoot(async (root) => {
    await assert.rejects(
      setupNpm(pin, {
        tempRoot: root,
        download: () => Promise.resolve(bytes),
        install: () => {},
        installedVersion: () => "1.2.4",
      }),
      /differs from pinned/,
    );
  });
});
