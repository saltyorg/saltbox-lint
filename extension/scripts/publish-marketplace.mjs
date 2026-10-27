// @ts-check
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishVSIX } from "@vscode/vsce";
import { readVSIX } from "./verify-package.mjs";
import { verifyRelease } from "./verify-release.mjs";

/**
 * Validate the entire qualified batch before admitting any Marketplace upload.
 * @param {string} directory
 * @param {string} tag
 * @param {string} commit
 * @param {{readPackage?: typeof readVSIX, publish?: typeof publishVSIX, lsRemote?: (tag: string) => string | Promise<string>}} [adapters]
 * @returns {Promise<string[]>}
 */
export async function publishMarketplace(
  directory,
  tag,
  commit,
  { readPackage = readVSIX, publish = publishVSIX, lsRemote } = {},
) {
  const filenames = await verifyRelease(directory, tag, commit, {
    readPackage,
    ...(lsRemote ? { lsRemote } : {}),
  });
  await publish(filenames, { azureCredential: true });
  return filenames;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await publishMarketplace(
    resolve(process.argv[2] ?? "dist"),
    process.env.RELEASE_TAG ?? "",
    process.env.RELEASE_COMMIT ?? "",
  );
}
