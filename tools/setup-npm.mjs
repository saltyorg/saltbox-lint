// @ts-check
// Replaces the runner's npm with the pinned release only after the downloaded
// registry tarball matches the integrity committed in npm-bootstrap.json. The
// verified local tarball is installed offline so no unverified bytes are used.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** @typedef {{version:string, integrity:string}} NpmPin */
/** @typedef {{download?:(url:string)=>Promise<Uint8Array>, install?:(tarball:string, cache:string)=>void, installedVersion?:()=>string, tempRoot?:string}} SetupDependencies */

export const pinFile = fileURLToPath(
  new URL("npm-bootstrap.json", import.meta.url),
);
const maxTarballBytes = 64 * 1024 * 1024;

/** @param {string} text @returns {NpmPin} */
export function parsePin(text) {
  /** @type {unknown} */
  const value = JSON.parse(text);
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join() !== "integrity,version"
  )
    throw new Error("npm pin must contain exactly version and integrity");
  const { version, integrity } = /** @type {Record<string, unknown>} */ (value);
  if (
    typeof version !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)
  )
    throw new Error(`npm pin version must be exact: ${String(version)}`);
  if (
    typeof integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
  )
    throw new Error("npm pin integrity must be one sha512 SRI value");
  return { version, integrity };
}

/** @param {string} version */
export function tarballURL(version) {
  return `https://registry.npmjs.org/npm/-/npm-${version}.tgz`;
}

/** @param {Uint8Array} bytes */
export function integrityOf(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** @param {string} url */
async function download(url) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(`npm tarball download failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxTarballBytes)
    throw new Error(`npm tarball exceeds ${maxTarballBytes} bytes`);
  return bytes;
}

// The global prefix that owns the npm on PATH, as laid out by Node installers
// and actions/setup-node on every runner platform.
function globalPrefix() {
  const bin = dirname(process.execPath);
  return process.platform === "win32" ? bin : dirname(bin);
}

function npmCLI() {
  const cli =
    process.platform === "win32"
      ? join(globalPrefix(), "node_modules", "npm", "bin", "npm-cli.js")
      : join(globalPrefix(), "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(cli))
    throw new Error(`npm CLI not found beside Node: ${cli}`);
  return cli;
}

/** @param {string} tarball @param {string} cache */
function install(tarball, cache) {
  const args = [
    npmCLI(),
    "install",
    "--global",
    `--prefix=${globalPrefix()}`,
    `--cache=${cache}`,
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    tarball,
  ];
  const result = spawnSync(process.execPath, args, {
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 300_000,
  });
  if (result.error)
    throw new Error("npm self-install could not run", { cause: result.error });
  if (result.status !== 0)
    throw new Error(
      `npm self-install exited with ${result.status ?? result.signal}`,
    );
}

function installedVersion() {
  const manifest = join(dirname(npmCLI()), "..", "package.json");
  /** @type {unknown} */
  const value = JSON.parse(readFileSync(manifest, "utf8"));
  return value && typeof value === "object" && "version" in value
    ? String(value.version)
    : "";
}

/** @param {NpmPin} pin @param {SetupDependencies} [dependencies] */
export async function setupNpm(pin, dependencies = {}) {
  const fetchTarball = dependencies.download ?? download;
  const runInstall = dependencies.install ?? install;
  const readVersion = dependencies.installedVersion ?? installedVersion;
  const bytes = await fetchTarball(tarballURL(pin.version));
  const actual = integrityOf(bytes);
  if (actual !== pin.integrity)
    throw new Error(
      `npm ${pin.version} tarball integrity mismatch: expected ${pin.integrity}, got ${actual}`,
    );
  const root = await mkdtemp(
    join(
      dependencies.tempRoot ?? process.env.RUNNER_TEMP ?? tmpdir(),
      "saltbox-npm-",
    ),
  );
  try {
    const tarball = join(root, `npm-${pin.version}.tgz`);
    await writeFile(tarball, bytes, { flag: "wx", mode: 0o600 });
    runInstall(tarball, join(root, "cache"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const installed = readVersion();
  if (installed !== pin.version)
    throw new Error(
      `installed npm ${installed} differs from pinned ${pin.version}`,
    );
  return pin;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const pin = await setupNpm(parsePin(readFileSync(pinFile, "utf8")));
  console.log(`Installed npm ${pin.version} verified by ${pin.integrity}`);
}
