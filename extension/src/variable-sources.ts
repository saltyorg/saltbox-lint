// Matches the backend's declaration source kinds without reading file contents.
export function variableDeclarationPath(file: string): boolean {
  if (!/\.(?:yml|yaml)$/i.test(file)) return false;
  const parts = file.split("/");
  const roleStart = parts[0] === "resources" ? 1 : 0;
  if (parts.length >= roleStart + 4 && parts[roleStart] === "roles")
    return ["defaults", "vars"].includes(parts[roleStart + 2]);
  const inventory =
    ["group_vars", "host_vars"].includes(parts[0]) ||
    (["inventory", "inventories"].includes(parts[0]) &&
      parts
        .slice(1, -1)
        .some((part) => ["group_vars", "host_vars"].includes(part)));
  if (inventory) return parts.at(-1) !== "localhost.yml";
  return ["inventory.yml", "inventory.yaml", "vars.yml", "vars.yaml"].includes(
    file,
  );
}
