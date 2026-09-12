# Local extension qualification

These opt-in harnesses never execute consumer roles or change their files. They
are outside routine CI because the corpus and managed Ansible interpreter are
operator-owned inputs. Use frozen snapshots plus their recorded manifest.

- `semantics.py CLI MANIFEST OUTDIR`: run with the pinned managed Python and
  `PYTHONDONTWRITEBYTECODE=1`. Applies returned edits only in memory/evidence,
  repeats the public formatter to require idempotence, and compares actual
  Ansible loader types, ordered mappings, scalars and tags. Ignores only source
  location tags; changed Jinja strings require exact non-whitespace lexer tokens.
  Invalid/unsupported formatter input stays separate from loader failures.
  The formatter itself independently checks both Go YAML parsers and comments.
- `controlled.py CLI OUTPUT.json`: same interpreter; controlled expressions,
  anchors, tags, scalar types and six strict Jinja renders. Never evaluates
  consumer templates or invokes Ansible lookups.
- `performance.py prepare BASELINE CANDIDATE MANIFEST OUTDIR`: predeclare binary,
  corpus, fixture, harness, code, environment and schedule identities. Optional
  paired microbenchmark executables are `task-6-micro/{A,B}-{lint,report}.test`
  alongside the manifest. Build A from the frozen baseline source, B from final
  sources. Preserve the original baseline binary and source archive.
- Add `--existing-only` to preparation for exactly the eight existing CLI
  workloads (160 samples); this omits new-formatter and microbenchmark reruns.
- `performance.py run OUTDIR`: run once, with other qualification/build work idle.
  Ten alternating AB/BA pairs per old CLI mode, real 160x48 PTYs for both palettes,
  pipes for JSON/stdin, identical sinks and runtime concurrency. A fresh small
  supervisor signals readiness before the actual child clock starts. Linux
  `wait4` records that child's CPU/RSS; selectors observe its first output.
  Supervisor startup/CPU/finish costs and pre-fork high-water mark are recorded
  separately. Every old-CLI sample must exceed its supervisor RSS floor. Keep every raw
  stdout/stderr and sample. Twenty new-formatter samples per fixture are separate;
  skipped plans do not prove successful formatting latency.
- `summarize.py OUTDIR`: retain every sample; report nearest-rank p95, median,
  range, standard deviation, paired wall ratios and exact-byte parity.

The installed editor's separate test controller supports
`SALTBOX_TEST_QUALIFICATION=1`, with `SALTBOX_QUALIFICATION_FIXTURES` set to the
prepared fixtures directory and `SALTBOX_QUALIFICATION_OUTPUT` to a new JSON path.
It runs 100 actual formatting requests, records editor/protocol/coordinate cost,
checks exact installed CLI process absence at 20 idle checkpoints, then closes
all tabs and checks cleanup. Heap/handle samples describe the entire extension
host, including the SDK; they are not attributed solely to this extension.

Do not rerun a formal series to select nicer outcomes. Diagnose failures and
record code/environment changes before a separately declared new experiment.
See `docs/vscode-extension-results.md` for qualified revisions and limitations.

For bounded attribution, `SALTBOX_TEST_PROFILE=1` records direct CLI, protocol,
production adapter, installed provider and application request phases separately.
`SALTBOX_TEST_LOGS` optionally preserves native SDK trace logs from the isolated
profile before cleanup. Application request completion is not a visual paint
completion guarantee. Profiling precedes the formal frozen experiment.

RSS interpretation: Linux wait4 includes the child's pre-exec launch image. A
large orchestration process can impose a floor on small CLI results. Record that
floor; use a separately declared fresh small supervisor for an RSS-only supplement
and verify every child peak exceeds its supervisor high-water mark. Keep the
original latency/CPU/first-output series and its raw RSS observations unchanged.

Boundary tests: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s
tools/qualification -p test_performance.py -v` exercises real child memory,
stdout/stderr, exit status, delayed output, readiness timing and PTY geometry.
The new helper and driver hashes are part of each new declaration; historical
declarations and raw samples are never rewritten for this measurement change.
