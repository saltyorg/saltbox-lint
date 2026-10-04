import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));

// Keep checks offline. Only same-repository blob/tree links to main are mapped
// to this checkout; published tags and other remote URLs are external links.
const repositoryPrefix = "https://github.com/saltyorg/saltbox-lint/";

export function withoutFences(markdown) {
  let fence;
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (
          match &&
          match[1][0] === fence[0] &&
          match[1].length >= fence.length &&
          !match[2].trim()
        )
          fence = undefined;
        return "";
      }
      if (match) {
        fence = match[1];
        return "";
      }
      return line;
    })
    .join("\n");
}

export function anchors(markdown) {
  const found = new Set();
  const counts = new Map();
  for (const match of withoutFences(markdown).matchAll(
    /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm,
  )) {
    const slug = match[1]
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
      .replace(/\s/g, "-");
    let count = counts.get(slug) ?? 0;
    let candidate = count ? `${slug}-${count}` : slug;
    while (found.has(candidate)) {
      count += 1;
      candidate = `${slug}-${count}`;
    }
    counts.set(slug, count + 1);
    found.add(candidate);
  }
  for (const match of withoutFences(markdown)
    .replace(/(`+)[^\n]*?\1/g, "")
    .matchAll(/<[^>]*\bid=["']([^"']+)["'][^>]*>/g))
    found.add(match[1]);
  return found;
}

function destinations(markdown) {
  const text = withoutFences(markdown);
  const references = new Map();
  const normalize = (label) => label.trim().replace(/\s+/g, " ").toLowerCase();
  for (const match of text.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)/gm)) {
    references.set(normalize(match[1]), match[2].replace(/^<|>$/g, ""));
  }
  const results = [];
  // Inline code examples are excluded; inline code inside link labels is fine.
  const prose = text.replace(
    /(`+)([^\n]*?)\1/g,
    (match, delimiter, contents, offset) => {
      const before = text.slice(0, offset);
      return before.lastIndexOf("[") > before.lastIndexOf("]") ? contents : "";
    },
  );
  for (const match of prose.matchAll(
    /!?\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g,
  )) {
    results.push(match[2].replace(/^<|>$/g, ""));
  }
  for (const match of prose.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const label = normalize(match[2] || match[1]);
    results.push(references.get(label) ?? `missing-reference:${label}`);
  }
  for (const match of prose.matchAll(/!?\[([^\]\n]+)\](?![(:\[])/g)) {
    const value = references.get(normalize(match[1]));
    if (value) results.push(value);
  }
  for (const match of prose.matchAll(/\b(?:href|src)=["']([^"']+)["']/g))
    results.push(match[1]);
  return results;
}

export function checkDocument(base, document) {
  const errors = [];
  for (let destination of destinations(
    readFileSync(resolve(base, document), "utf8"),
  )) {
    try {
      if (destination.startsWith("missing-reference:"))
        throw new Error(destination);
      if (destination.startsWith(repositoryPrefix)) {
        const local = /^(?:blob|tree)\/main\/(.+)$/.exec(
          destination.slice(repositoryPrefix.length),
        );
        if (!local) continue;
        destination = `/${local[1]}`;
      } else if (
        /^[a-z][a-z\d+.-]*:/i.test(destination) ||
        destination.startsWith("//")
      )
        continue;
      const [pathAndQuery, fragment] = destination.split("#");
      const path = decodeURIComponent(pathAndQuery.split("?")[0]);
      const target = path.startsWith("/")
        ? resolve(base, `.${path}`)
        : resolve(base, dirname(document), path || document.split("/").at(-1));
      const scoped = relative(base, target);
      if (
        scoped === ".." ||
        scoped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        isAbsolute(scoped)
      )
        throw new Error("path escapes repository");
      const info = statSync(target);
      if (
        fragment &&
        target.endsWith(".md") &&
        !anchors(readFileSync(target, "utf8")).has(decodeURIComponent(fragment))
      )
        throw new Error(`missing anchor #${fragment}`);
      if (fragment && !info.isFile())
        throw new Error("anchor target is not a file");
    } catch (error) {
      errors.push(`${document}: ${destination}: ${error.message}`);
    }
  }
  return errors;
}

export function maintainedDocuments(base = root) {
  return [
    "README.md",
    "extension/README.md",
    "extension/CHANGELOG.md",
    "extension/PRIVACY.md",
    "extension/SUPPORT.md",
    "tools/qualification/README.md",
    "tools/oracles/README.md",
    "highlight/ASSETS.md",
    "highlight/testdata/README.md",
    "highlight/semantics/testdata/README.md",
    ...readdirSync(resolve(base, "docs"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/${name}`),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = maintainedDocuments().flatMap((document) =>
    checkDocument(root, document),
  );
  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  } else
    process.stdout.write("Maintained documentation links passed (offline).\n");
}
