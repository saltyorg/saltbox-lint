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

/** Classify one complete stderr line without copying or decoding its bytes. */
export function observeCLIErrorStage() {
  let candidates = prefixes.map((_, index) => index);
  let matched: number | undefined;
  let bytes = 0;
  let invalid = false;
  let ended = false;
  let remaining = 0;
  let minimum = 0x80;
  let maximum = 0xbf;

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
        remaining--;
        minimum = 0x80;
        maximum = 0xbf;
      } else if (byte >= 0x80) {
        if (byte >= 0xc2 && byte <= 0xdf) remaining = 1;
        else if (byte >= 0xe0 && byte <= 0xef) {
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

  function dispose() {
    candidates = [];
    matched = undefined;
    invalid = true;
  }
  return { observe, stage, dispose };
}
