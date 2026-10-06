# Check statistics

Use `saltbox-lint check --stats` to report counts and phase timings. Statistics
are disabled by default. They do not change source selection, diagnostics,
fixes, or lint exit codes. The editor does not request statistics.

With `--format json`, the existing schema version 2 envelope has an optional
`statistics` object. Its independent `schema_version` is `1`. Human, concise,
GitHub and SARIF output put statistics on stderr after the report. SARIF retains
its existing schema and stdout bytes. With `--diff`, stdout contains only the
patch, and stderr contains the original diagnostics followed by statistics.

```sh
saltbox-lint check roles/example --stats --format json
saltbox-lint check roles/example --diff --stats
```

The statistics object has these fields:

| Field | Meaning |
| --- | --- |
| `schema_version` | Statistics schema version, currently `1`. |
| `status` | `complete`, `partial`, or `failed`. Findings, including syntax findings, do not constitute operational failure. |
| `duration_unit` | `milliseconds`. |
| `initial` | Counts from the initial admitted project and selected analysis result. Absent when that analysis did not complete. |
| `rechecked` | Counts after `--fix` writes and rechecks. Absent when no recheck completed. |
| `planned_files` | Number of verified file changes returned by fix planning. Absent if planning was not requested or failed. |
| `applied_files` | Number of changed files after successful writing. Absent if writing was not requested or failed, because a failure cannot establish a complete write count. |
| `phases` | Phase records in observation order, with the exceptions described below for JSON. |

Each count snapshot contains `sources`, `selected`, `context`, `source_kinds`,
`parse_failed_sources`, `parse_findings`, `findings`, `fixes`, and `rules`.
`sources` counts admitted sources; `selected + context` equals `sources`.
`source_kinds` is sorted by `kind`; each entry has `kind`, `selected`, and
`context`. The kinds are the shared analysis kinds, including `template`.

`parse_failed_sources` and `parse_findings` include both selected and context
sources in the admitted project. `findings` and the `rules` totals cover only
selected primary locations, exactly as the report does. `rules` is sorted by
`rule_id`; each entry has `rule_id` and `count`. `fixes` counts unique shared
fixes by source path, message, and ordered edit contents. Several diagnostics
can reference one fix. It is not a diagnostic-reference or edit count.

Each phase has `name`, `status`, `scope`, and `duration_ms`. A null duration
means unavailable, never zero. Completed measured work has status `complete`;
an interrupted active phase has status `failed`. Parser work completed before
a loader failure has status `partial`, or `unavailable` if no parser ran.
Phases that were never entered are absent. Top-level status is `partial` when
an operational failure follows a completed phase, and `failed` otherwise.

The phase names are `input`, `discovery_loading`, `parsing`, `analysis`,
`fix_selection`, `fix_planning`, `fix_writing`, `recheck_discovery_loading`,
`recheck_parsing`, `recheck_analysis`, `report_preparation`, `rendering`, and
`encoding_writing`. Only applicable phases appear. `input` includes option
validation and reading stdin. Load phases include discovery, reading, parsing,
context admission, and any requested dependency/changed-selection work.

Load phases use `scope: "wall"`. Parsing phases use
`scope: "aggregate_worker"` and include `parse_attempts`. Their durations sum
parser elapsed time across the loader's workers, including candidates parsed
and rejected by directory admission. Parser work overlaps with load time and
other parser workers. Do not add these numbers to load time or interpret them
as a separate wall-clock interval. They use the monotonic clock, not CPU time.

`report_preparation` covers conversion to report records and, for JSON,
construction of the diagnostic/fix envelope. JSON records `encoding_writing`
with status `unavailable` and a null duration before encoding. It cannot
measure the final write of the envelope that contains its own statistics.
The unavailable entry precedes completed report preparation in that envelope.
Other formats report `rendering` after output completes; it includes report
preparation, any GitHub summary handling, and patch output in diff mode.
Statistics preparation and the final stderr statistics write are not included
in rendering time. No report is buffered merely to time it.

Counts and their ordering are deterministic for the same admitted result.
Durations vary with the host, concurrency, and filesystem. Statistics contain
no source text, variable values, or filesystem paths. They do not force an
additional dependency record, source read, or analysis pass.

On an operational failure, partial statistics go to stderr even in JSON mode;
the original error and exit code 2 remain. A report output failure can leave
incomplete stdout, as it can without statistics. A statistics output failure
also produces an operational error. Cancellation uses the existing process
and worker cleanup behavior.

For end-to-end measurements, use the opt-in
[qualification tools](../tools/qualification/README.md). Their wall, child CPU,
and peak RSS measurements are separate from these internal phase durations.
Record the inputs, binaries, tools, and every sample before drawing a performance
conclusion. Statistics alone do not justify adding a cache.
