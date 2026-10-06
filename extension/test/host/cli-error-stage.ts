import { posix, win32 } from "node:path";

// Fixed prefixes owned by main.go, cmd/query.go, lint/query.go and
// lint/discovery.go. Dynamic paths and wrapped errors are never retained.
const prefixes = [
  ["create editor process job: ", "error_editor_job_create"],
  ["configure editor process job: ", "error_editor_job_configure"],
  ["assign editor process job: ", "error_editor_job_assign"],
  [
    "saltbox-lint: query requires '-' and --stdin-filename\n",
    "error_query_arguments",
  ],
  ["saltbox-lint: read query stdin: ", "error_query_stdin_read"],
  [
    "saltbox-lint: query snapshot exceeds 16 MiB\n",
    "error_query_snapshot_limit",
  ],
  ["saltbox-lint: unknown query operation ", "error_query_operation"],
  [
    "saltbox-lint: query offset must be a valid UTF-8 source boundary outside CRLF\n",
    "error_query_offset",
  ],
  ["saltbox-lint: query requires a selected source\n", "error_query_selection"],
  ["saltbox-lint: no source targets selected\n", "error_source_selection"],
  ["saltbox-lint: stdin requires a filename\n", "error_source_stdin_filename"],
  ["saltbox-lint: open source root ", "error_source_root_open"],
  ["saltbox-lint: discover Git sources in ", "error_git_sources_discover"],
  ["saltbox-lint: inspect target ", "error_source_target_inspect"],
  [
    "saltbox-lint: selected spelling owner changed during admission: ",
    "error_source_spelling_admit",
  ],
  [
    "saltbox-lint: no supported sources selected\n",
    "error_source_supported_selection",
  ],
  [
    "saltbox-lint: inspect reference context ",
    "error_reference_context_inspect",
  ],
  ["saltbox-lint: inspect context ", "error_source_context_inspect"],
  ["saltbox-lint: read Git administrative pointer: ", "error_git_pointer_read"],
  [
    "saltbox-lint: admit Git administrative pointer: ",
    "error_git_pointer_admit",
  ],
  [
    "saltbox-lint: locate Git discovery controls in ",
    "error_git_controls_locate",
  ],
  [
    "saltbox-lint: admit Git administrative directory: ",
    "error_git_directory_admit",
  ],
  [
    "saltbox-lint: resolve Git administrative owner: ",
    "error_git_owner_resolve",
  ],
  [
    "saltbox-lint: stdin source spelling changed owner\n",
    "error_source_stdin_owner",
  ],
  ["saltbox-lint: unsupported source target ", "error_source_unsupported"],
  ["saltbox-lint: source identity changed for ", "error_source_identity"],
  ["saltbox-lint: resolve source ", "error_source_resolve"],
  ["saltbox-lint: open source parent ", "error_source_parent_open"],
  ["saltbox-lint: inspect source ", "error_source_inspect"],
  ["saltbox-lint: source is not a regular file: ", "error_source_regular"],
  ["saltbox-lint: open source ", "error_source_open"],
  ["saltbox-lint: read source ", "error_source_read"],
  [
    "saltbox-lint: source changed while reading: ",
    "error_source_read_identity",
  ],
  ["saltbox-lint: discover sources in ", "error_source_discover"],
  ["saltbox-lint: empty source target\n", "error_source_target_empty"],
  ["saltbox-lint: resolve target ", "error_source_target_resolve"],
  ["saltbox-lint: resolve directory ", "error_source_directory_resolve"],
  ["saltbox-lint: inspect root ", "error_source_root_inspect"],
  [
    "saltbox-lint: source root is not a directory: ",
    "error_source_root_directory",
  ],
  ["saltbox-lint: inspect project identity: ", "error_project_identity"],
  ["saltbox-lint: inspect Git root: ", "error_git_root_inspect"],
] as const;

const limit = 256 * 1024;
const unknown = "error_stage_unknown";

// The paths below belong to the original first-definition fixture. Ownership
// is fixture-declared; these comparisons perform no filesystem inspection.
const contextKinds = ["defaults", "vars", "tasks", "handlers", "templates"];
const contextDirectories = [
  ...[
    "navsource",
    "navtarget",
    "resource_navtarget",
    "example",
    "readonly",
    "readonly-directory",
    "template-origin",
  ].flatMap((role) =>
    contextKinds.map((kind) => ({
      id: `${role.replaceAll("-", "_")}_${kind}`,
      relative: `${role === "resource_navtarget" ? "resources/roles/navtarget" : `roles/${role}`}/${kind}`,
    })),
  ),
  ...["group_vars", "host_vars", "inventory", "inventories"].map((name) => ({
    id: name,
    relative: name,
  })),
];

// Exact text comparisons only. Localized or changed messages stay unknown.
const errorTexts = [
  ["Access is denied.", "text_permission"],
  ["permission denied", "text_permission"],
  [
    "The filename, directory name, or volume label syntax is incorrect.",
    "text_invalid_name",
  ],
  ["The directory name is invalid.", "text_non_directory"],
  ["not a directory", "text_non_directory"],
  ["The system cannot find the file specified.", "text_missing_file"],
  ["The system cannot find the path specified.", "text_missing_path"],
  ["no such file or directory", "text_missing_file_or_path"],
  ["path escapes from parent", "text_root_escape"],
  ["too many symlinks", "text_symlink_limit"],
  ["EvalSymlinks: too many links", "text_symlink_limit"],
] as const;

interface ContextPattern {
  segments: Uint8Array[];
  length: number;
  directory: string;
  branch: string;
  errorTextClass: string;
  rank: number;
  exact: boolean;
}

function contextPatterns(root: unknown, platform: NodeJS.Platform) {
  if (
    typeof root !== "string" ||
    !root.length ||
    root.length > 4096 ||
    Buffer.byteLength(root) > 4096 ||
    /[\p{Cc}\p{Zl}\p{Zp}\uD800-\uDFFF]/u.test(root)
  )
    return [];
  const paths = platform === "win32" ? win32 : posix;
  if (!paths.isAbsolute(root)) return [];
  let roots = [root];
  if (platform === "win32") {
    const normal = win32.normalize(
      root.replace(/^\\\\\?\\UNC\\/u, "\\\\").replace(/^\\\\\?\\/u, ""),
    );
    if (
      !/^[a-z]:\\/iu.test(normal) &&
      !/^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.test(normal)
    )
      return [];
    // Drive case and extended prefixes are lexical variants, not discovered aliases.
    roots = /^[a-z]:/iu.test(normal)
      ? [
          normal[0].toUpperCase() + normal.slice(1),
          normal[0].toLowerCase() + normal.slice(1),
        ]
      : [normal];
    roots = [
      ...roots,
      ...roots.map((value) =>
        value.startsWith("\\\\")
          ? "\\\\?\\UNC\\" + value.slice(2)
          : "\\\\?\\" + value,
      ),
    ];
  }
  const patterns: ContextPattern[] = [];
  const texts = errorTexts.map(([text, code]) => ({
    bytes: Buffer.from(text + "\n"),
    code,
  }));
  for (const knownRoot of new Set(roots)) {
    for (const directory of contextDirectories) {
      const absolute = paths.join(knownRoot, directory.relative);
      const outer = Buffer.from(`saltbox-lint: inspect context ${absolute}: `);
      function add(
        segments: Uint8Array[],
        branch: string,
        errorTextClass = "text_unknown",
        rank = 1,
        exact = false,
      ) {
        patterns.push({
          segments,
          length: segments.reduce((sum, part) => sum + part.byteLength, 0),
          directory: directory.id,
          branch,
          errorTextClass,
          rank,
          exact,
        });
      }
      add([outer], "context_branch_unknown");
      const resolve = Buffer.from(`resolve source ${absolute}: `);
      const stat = Buffer.from(
        `statat ${paths.normalize(directory.relative)}: `,
      );
      add([outer, resolve], "context_resolve_source", "text_unknown", 2);
      add([outer, stat], "context_root_stat", "text_unknown", 2);
      add(
        [
          outer,
          Buffer.from(`source ${absolute} is outside root ${knownRoot}\n`),
        ],
        "context_outside_root",
        "text_outside_root",
        3,
        true,
      );
      const operations =
        platform === "win32"
          ? ["CreateFile", "readlink"]
          : ["lstat", "readlink"];
      const wrapped = operations.map((operation) =>
        Buffer.from(`${operation} ${absolute}: `),
      );
      for (const text of texts) {
        add([outer, stat, text.bytes], "context_root_stat", text.code, 3, true);
        // EvalSymlinks also returns fixed errors without an os.PathError wrapper.
        add(
          [outer, resolve, text.bytes],
          "context_resolve_source",
          text.code,
          3,
          true,
        );
        for (const operation of wrapped)
          add(
            [outer, resolve, operation, text.bytes],
            "context_resolve_source",
            text.code,
            3,
            true,
          );
      }
    }
  }
  return patterns;
}

/** Classify one complete stderr line without copying or decoding its bytes. */
export function observeCLIErrorStage(
  root?: unknown,
  platform: NodeJS.Platform = process.platform,
) {
  let patterns = contextPatterns(root, platform);
  const contextAvailable = patterns.length > 0;
  let contextCandidates = patterns.map((_, index) => index);
  let contextMatched: number[] = [];
  let candidates = prefixes.map((_, index) => index);
  let matched: number | undefined;
  let bytes = 0;
  let invalid = false;
  let ended = false;
  let remaining = 0;
  let minimum = 0x80;
  let maximum = 0xbf;
  // Finite progress through E2 80 A8/A9, the Unicode line separators.
  let lineSeparator = 0;

  function observe(data: unknown) {
    if (invalid) return;
    if (!(data instanceof Uint8Array) || bytes + data.byteLength > limit) {
      invalid = true;
      candidates = [];
      matched = undefined;
      return;
    }
    for (const byte of data) {
      if (ended) {
        invalid = true;
        return;
      }
      // UTF-8 validation retains only continuation counts and allowed ranges.
      if (remaining > 0) {
        if (byte < minimum || byte > maximum) {
          invalid = true;
          return;
        }
        if (lineSeparator === 2 && (byte === 0xa8 || byte === 0xa9)) {
          invalid = true;
          return;
        }
        lineSeparator = lineSeparator === 1 && byte === 0x80 ? 2 : 0;
        remaining--;
        minimum = 0x80;
        maximum = 0xbf;
      } else if (byte >= 0x80) {
        lineSeparator = byte === 0xe2 ? 1 : 0;
        if (byte >= 0xc2 && byte <= 0xdf) {
          remaining = 1;
          // C2 80..9F encodes the C1 controls, including NEXT LINE.
          minimum = byte === 0xc2 ? 0xa0 : 0x80;
        } else if (byte >= 0xe0 && byte <= 0xef) {
          remaining = 2;
          minimum = byte === 0xe0 ? 0xa0 : 0x80;
          maximum = byte === 0xed ? 0x9f : 0xbf;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          remaining = 3;
          minimum = byte === 0xf0 ? 0x90 : 0x80;
          maximum = byte === 0xf4 ? 0x8f : 0xbf;
        } else {
          invalid = true;
          return;
        }
      } else if (byte < 0x20 || byte === 0x7f) {
        if (byte !== 0x0a) {
          invalid = true;
          return;
        }
        ended = true;
      }
      contextCandidates = contextCandidates.filter((index) => {
        const pattern = patterns[index];
        let offset = bytes;
        let expected: number | undefined;
        for (const segment of pattern.segments) {
          if (offset < segment.byteLength) {
            expected = segment[offset];
            break;
          }
          offset -= segment.byteLength;
        }
        if (expected !== byte) return false;
        if (bytes + 1 === pattern.length) {
          contextMatched.push(index);
          return false;
        }
        return true;
      });
      candidates = candidates.filter((index) => {
        const literal = prefixes[index][0];
        if (literal.charCodeAt(bytes) !== byte) return false;
        if (bytes + 1 === literal.length) {
          matched = index;
          return false;
        }
        return true;
      });
      bytes++;
    }
  }

  function stage(closed: boolean, exitCode: number | null | undefined) {
    if (
      !closed ||
      exitCode !== 2 ||
      invalid ||
      !ended ||
      remaining ||
      matched === undefined
    )
      return unknown;
    const [literal, code] = prefixes[matched];
    return literal.endsWith("\n")
      ? bytes === literal.length
        ? code
        : unknown
      : bytes > literal.length + 1
        ? code
        : unknown;
  }

  function context(closed: boolean, exitCode: number | null | undefined) {
    const fallback = {
      availability: contextAvailable
        ? "context_directory_unknown"
        : "context_comparison_unavailable",
      ambiguous: false,
      directory: "directory_unknown",
      branch: "context_branch_unknown",
      errorTextClass: "text_unknown",
    };
    if (stage(closed, exitCode) !== "error_source_context_inspect")
      return fallback;
    const matches = contextMatched
      .map((index) => patterns[index])
      .filter((pattern) =>
        pattern.exact ? bytes === pattern.length : bytes > pattern.length + 1,
      );
    const rank = Math.max(0, ...matches.map((pattern) => pattern.rank));
    const best = matches.filter((pattern) => pattern.rank === rank);
    if (!best.length) return fallback;
    const first = best[0];
    const ambiguous = best.some(
      (pattern) =>
        pattern.directory !== first.directory ||
        pattern.branch !== first.branch ||
        pattern.errorTextClass !== first.errorTextClass,
    );
    if (ambiguous)
      return {
        ...fallback,
        availability: "context_comparison_ambiguous",
        ambiguous: true,
      };
    return {
      availability: "context_directory_known",
      ambiguous: false,
      directory: first.directory,
      branch: first.branch,
      errorTextClass: first.errorTextClass,
    };
  }

  function dispose() {
    candidates = [];
    matched = undefined;
    contextCandidates = [];
    contextMatched = [];
    patterns = [];
    invalid = true;
  }
  return { observe, stage, context, dispose };
}
