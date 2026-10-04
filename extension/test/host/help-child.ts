import { realpathSync } from "node:fs";

// Extension.extensionPath and ExtensionContext.asAbsolutePath can spell the
// Windows drive differently. Observe only these exact installed help requests.
export function helpChildMatcher(executable: string) {
  const installed = realpathSync.native(executable);
  return (file: string, argv: readonly string[] | undefined): boolean => {
    if (
      !argv ||
      !(
        (argv.length === 1 && argv[0] === "--version") ||
        (argv.length === 3 &&
          argv[0] === "rules" &&
          argv[1] === "--format" &&
          argv[2] === "json")
      )
    )
      return false;
    try {
      return realpathSync.native(file) === installed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
}
