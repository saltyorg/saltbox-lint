# Extension testing

The extension is TypeScript, its external test tools run on Node, and its
backend is Go. Test each behavior at the layer that owns its contract. Keep real
editor and native-process checks for contracts that a component fake cannot
establish. Follow [contributor validation](contributing.md) and
[package and release validation](extension-release.md) for the required gates,
platform targets, artifact verification and publication boundaries.

## Upstream guidance

Use Microsoft's [extension testing guide](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
for supported extension-host tooling and
[test-writing instructions](https://github.com/microsoft/vscode/blob/main/.github/instructions/writing-tests.instructions.md)
for dependency injection, mock restoration and disposable ownership. Microsoft's
internal disposable-leak helper is not a public extension API. This repository
must provide its own ownership checks.

Use named Mocha cases with returned promises and awaited hooks in the real
editor. Follow Mocha's [asynchronous tests](https://mochajs.org/features/asynchronous-code/)
and [hooks](https://mochajs.org/features/hooks/) contracts. Keep the
[`test-electron` launcher](https://github.com/microsoft/vscode-test) responsible
for editor installation and launch. A custom installer must use the same
user-data and extensions directories as its subsequent launch.

For external component tests, use the pinned Node
[test runner](https://nodejs.org/download/release/v24.20.0/docs/api/test.html).
A completed test promise does not join background work created by the test.
Use explicit ownership for event listeners, timers, writes and subprocesses.
Node's [child-process API](https://nodejs.org/download/release/v24.20.0/docs/api/child_process.html)
distinguishes `spawn`, `exit` and `close`. A delivered kill signal does not prove
termination or descendant cleanup. Register
[event waiters](https://nodejs.org/download/release/v24.20.0/docs/api/events.html#caveats-when-awaiting-multiple-events)
before their trigger, including events that can arrive in the same synchronous
batch.

External Node and the editor's embedded Node are separate runtimes. Host tests
record actual VS Code, Node and Electron versions. Build the controller for the
minimum supported host and prove its dependencies execute in both configured
editors. The pinned Mocha 12 package uses an ESM entry point; the controller
loads its public default export with native `import()`. Keep that import external
to the controller bundle and include the pinned development dependencies in the
controller installation. The minimum editor's Node 20 runtime and the external
Node 24 runtime expose different CommonJS/ESM interoperability behavior; an
external import check cannot qualify the host runner.

Keep TypeScript [type checking](https://www.typescriptlang.org/tsconfig/noEmit.html)
and typed [promise linting](https://typescript-eslint.io/rules/no-floating-promises/)
separate from transpilation and execution. Type assertions cannot validate a
fake at runtime.
Supply the public fields and methods that the caller actually consumes, and
back filesystem-facing URI doubles with owned real fixtures. Qualify the
affected host callers and their existing unit fixtures alongside a changed
helper; passing the helper's standalone tests does not establish its callers'
contracts.

## Test layers and resource owners

| Layer | Executable inputs | Observable completion | Owner and cleanup |
| --- | --- | --- | --- |
| Go behavior | [`cmd`](../cmd), [`lint`](../lint), [`format`](../format), [`yamlindex`](../yamlindex), [`report`](../report) tests | Public command result, protocol facts, exact bytes or explicit joined worker result | The Go test owns its temporary inputs and workers. Use cleanup hooks and join started processes. |
| TypeScript behavior | [`test/unit`](../extension/test/unit), importable production and helper modules | Exact result or state after controlled dependencies settle | Each test owns its deferred operations, clock, subscriptions and temporary files. Dependency fakes are private to that test. |
| Native adapters | [`process.test.ts`](../extension/test/unit/process.test.ts), [`release-liveness.test.mjs`](../extension/test/release-liveness.test.mjs), [`process-gate.test.mjs`](../extension/test/process-gate.test.mjs) | Pipes close, owned lifetime credentials become absent, exact exit/error and output are retained | The process owner cancels and joins its child tree. File removal follows completed writers and terminated owners. |
| Editor integration | [`test/host`](../extension/test/host), [`test-host.mjs`](../extension/scripts/test-host.mjs) | Current-generation diagnostics, returned provider result, saved/edit event or exact fixture readiness acknowledgement | The case owns documents, settings, providers and operations. The external launcher owns the editor and run directories, including crash cleanup. |
| Installed package acceptance | [`test-native-hosts.mjs`](../extension/scripts/test-native-hosts.mjs), [`test-package.mjs`](../extension/scripts/test-package.mjs), [`test-binary.mjs`](../extension/scripts/test-binary.mjs) | Verified installed product path/version/backend, successful user flow and cleanup result | The launcher owns isolated installation profiles and processes. The package verifier owns extracted archives. |

Command tests clear inherited `GITHUB_STEP_SUMMARY` in their `TestMain` so
synthetic GitHub-format findings cannot append to the runner's real summary.
Tests of summary behavior set private destinations with `t.Setenv`. A subprocess
regression exercises the rendering tests and summary controls with an outer
sentinel file and verifies that its bytes remain unchanged. Keep production
GitHub summary output enabled for actual CLI invocations.

Every owner registers cleanup immediately after acquiring a resource. Cleanup
stops new work, cancels producers, joins admitted operations, restores state and
checks that its resources are gone. Use a separate bounded cleanup scope. An
already-aborted operation signal must not cancel the wait for child closure or
state restoration. Report both the original error and cleanup errors.
Socket fixtures track transport errors separately from the actual
[`close` event](https://nodejs.org/download/release/v24.20.0/docs/api/net.html#event-close_1).
[`events.once`](https://nodejs.org/download/release/v24.20.0/docs/api/events.html#eventsonceemitter-name-options)
rejects on `error`, so it cannot acknowledge cleanup when a fixture deliberately
resets a connection. Join closure before checking errors, permit a reset only
in its specific abort control, and keep protocol acknowledgement errors failing.
The resource owner applies an independent deadline to admitted-operation
joining before restoration begins. Expiration records a cleanup failure and
still awaits the actual promises; it cannot establish resource release. A
noncooperative operation requires the external worker owner to reap it. A Mocha
timeout cancels the current case owner, then the controller joins its admitted
case promise before reporting completion.
Nested cohorts receive the parent operation signal. They cancel their producers
when it aborts, retain their own cleanup signals and join their bodies and
restoration before returning. Propagating a signal alone does not dispose an
adapter whose only cleanup hook runs after its body; use the joined-resource
owner for that cancellation boundary.

The external POSIX owner acknowledges a per-request reservation before the
editor detaches a child. The native guardian binds its live group to that nonce
before CLI work. No-child cancellation and joined-child completion are distinct
operations. An editor crash during bootstrap can leave an unbound reservation;
that fails qualification and retains the profile. Stop registered groups only
through their authenticated live channels, then verify group disappearance.
Numeric PID or group records never authorize a later signal. Windows retains
its native Job ownership.

The POSIX command owner also keeps its detached worker in a group led by a
Node guardian. The guardian installs its parent-lifetime handlers before
acknowledging readiness, admits the payload only on the live IPC channel and
stops its own current group on parent disconnect or an explicit stop. Payload
exit/status remains separate from guardian exit. Joining includes control writes,
native exit, pipe closure, IPC disconnection and read-only group disappearance.
The guard remains alive after payload completion so termination never depends
on a reused numeric process identifier.
The crash regression joins lifetime sockets and native groups separately.
A real payload can close its socket while remaining live behind a control gate;
that control must not report release until native group disappearance is observed.
The native regression reproduces a Node 24.20 IPC write failure where the
composite child close event is missing despite native exit, closed output
streams and disconnected IPC. Those actual public receipts and joined writes
establish release; a fabricated close event cannot do so. Phase observers use a
monotonic clock. Reporting or clock failures remain final failures after owned
acquisition, joining and restoration finish, with unavailable timing explicit.

Read-only group probes keep their one-second deadline and four-MiB output bound.
Linux checks every advertised thread. Its `ps` output reads task files
separately while threads can exit. A valid owned snapshot with incomplete thread
coverage, a missing leader or changing thread counts returns `true`: the group
has live members or their absence is not yet proved. Existing bounded owner
polling continues. `false` requires complete all-zombie owned coverage or a
completed, valid global query with no owned members. Malformed rows, duplicate
threads, invalid identities, missing final newlines and native query failures
remain errors; owners do not retry those errors. See the
[procps task enumeration](https://gitlab.com/procps-ng/procps/-/blob/v4.0.4/library/readproc.c)
and [Linux per-task stat reads](https://github.com/torvalds/linux/blob/v6.8/fs/proc/array.c).

Darwin selects only the owned group with
`ps -g PGID -x -o pgid=,pid=,state=` and a private `COMMAND_MODE=unix2003`
environment, preserving non-terminal members and avoiding legacy selector
semantics. Accept an empty Darwin selection only after the probe closes with
exit 1, empty output and no kill, signal or cancellation. Diagnostics, malformed
rows and other probe failures remain inconclusive. Failure reporting retains the
original cause and bounded status, timing and output-size metadata. See Apple's
[process selection implementation](https://github.com/apple-oss-distributions/adv_cmds/blob/6bed8737a34dbb54782a18f47dccf933a9967a12/ps/ps.c)
and [compatibility contract](https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/gen/compat.5).

Production process cleanup and development command owners share
[`native-group.ts`](../extension/src/native-group.ts). The development
[`owned-group.mjs`](../extension/scripts/owned-group.mjs) facade preserves its
existing interface; copied-source fixtures include the shared implementation.
POSIX cancellation and operational failures first signal the owned child PID.
Its native exit receipt admits the descendant group sweep. An already-observed
exit retains the existing group signal path. Separate child/group signal adapters
control genuine permission failures and the dying-group race in the native
process tests; both keep their original phase and native-exit evidence.
A Darwin `EPERM` during exit cleanup, or cancellation after native exit was
already observed at the failed signal, is recoverable only after a fresh,
independent bounded observation proves no live group members and the child,
stdio and observation have joined. Record native exit state at the first failed
signal and preserve its trigger phase; a later exit cannot qualify an earlier
fault. All other trigger phases, cancellation without that recorded exit proof,
live or unknown groups, query failures and other error codes remain failures.
Preserve both original operation and cleanup errors. Bounded metadata includes
trigger phase, recorded native exit state, target, code, errno and syscall. Node sets
[`exitCode`](https://nodejs.org/download/release/v24.18.1/docs/api/child_process.html#subprocessexitcode)
and [`signalCode`](https://nodejs.org/download/release/v24.18.1/docs/api/child_process.html#subprocesssignalcode)
before exit listeners run; stream closure is joined separately. See Apple's
[group signalling implementation](https://github.com/apple-oss-distributions/xnu/blob/43a90889846e00bfb5cf1d255cdc0a701a1e05a4/bsd/kern/kern_sig.c#L1608-L1617).

`EditorIntegration.join()` owns complete background rendering/synchronization,
file and refresh timer producers, and root probes as well as backend lanes.
Disposal seals admission, cancels producers and leaves admitted work joinable.
Standard deactivation still joins after disposal errors, preserves combined
failures and shares duplicate cleanup ownership, as verified through the real
entry and editor in [`deactivation.test.ts`](../extension/test/unit/deactivation.test.ts).
Tab cleanup reads fresh public snapshots and matches resource identity using
public input/URI/view-column data. The minimum editor can report final tab
removal through a group-model update without a separate closed-tab event;
current absence is the completion condition after the close command settles.
Dirty activation follows the document model actually returned by
`showTextDocument`, including replacement models for the same URI. Scoped cleanup
rejects a returned resource outside its owned URI set. The imported helper and
SDK-adapter tests retain original errors, command joining and listener disposal;
bounded failure records preserve the cleanup stage and public tab/model identities.

Editor, help, provider and root-watcher setup own each successful acquisition
immediately. A later setup failure rolls back every acquired resource and
retains both the original error and rollback errors. Initial root configuration
starts after the editor owner has been returned; readiness and joining observe
that initialization. Disposal before initialization prevents new probes, and
joining still waits for probes admitted before a configuration failure.

Prefer a current-generation acknowledgement over elapsed sleeps. A timer bounds
an operation; it does not prove readiness. A timeout must cancel and join its
losing operation. Each case must run alone and after another case with no
inherited activation, dirty buffer, configuration, control gate or fixture
process.

The installed-package preflight must reject a mismatched installation/launch
directory, loaded path, version or backend before the user flow starts. A
controller that embeds development classes is a component editor test. It does
not establish that those classes came from the installed VSIX.

## Filesystem identity and diagnostic keys

VS Code diagnostic collections use resource URI keys. The minimum editor's
[diagnostic collection](https://github.com/microsoft/vscode/blob/1.100.0/src/vs/workbench/api/common/extHostDiagnostics.ts)
uses the URI [comparison key](https://github.com/microsoft/vscode/blob/1.100.0/src/vs/base/common/resources.ts);
that comparison does not resolve filesystem symlinks. Node's
[native realpath](https://nodejs.org/download/release/v24.20.0/docs/api/fs.html#fsrealpathsyncnativepath-options)
establishes a separate filesystem identity. A workspace URI, a returned document
URI and a native saved-source URI can therefore name different resources.

Capture the native URI of closed saved fixtures while the source exists, before
testing rename or deletion. Query open or dirty models using the actual returned
`document.uri`, and preserve exact tab identity. Watcher controls must observe
the actual callback, source ownership and intended current bytes. A generic
realpath fallback for all diagnostic lookups would hide these distinct contracts.
The ownerless-file selection case explicitly opens a canonical file; its
separate public workspace-alias and known unmarked-owner cases remain required.

Qualify changes to filesystem/URI identity through a real parent directory
symlink or Windows junction, verifying that public and native paths differ and
identify the same owned directory. Run every required profile in both configured
editors from that base, alongside ordinary-path qualification. Keep exact
diagnostic, dirty-overlay, source-owner, deletion and restoration assertions;
do not rewrite production URI policy to fit a fixture's path spelling.

Subcase aggregation retains each original error object and its complete causes,
including independent teardown errors. The final failure must include earlier
subcase errors when later cohort setup, operations or cleanup reject. Console
output or a list of failed names cannot replace that retained graph. The imported
[`subcase owner`](../extension/test/support/subcase-failures.ts) and its
[failure tests](../extension/test/unit/subcase-failures.test.ts) cover this boundary.

Provider assertions retain the original public command response and bounded
document, diagnostic and editor-event context when they fail. The I1
[failure observer](../extension/test/support/code-action-evidence.ts) and its
[ownership tests](../extension/test/unit/code-action-evidence.test.ts) preserve
the original assertion together with observation or cleanup faults, using the
same query and budgets. A public empty action response does not expose provider
invocations, registry changes or its cancellation token; report those fields
as unavailable rather than infer an extension cache failure. Failure context
adds no retries, provider polls or additional lint checks.

## Editor coverage inventory

The inventory below records the existing contracts at commit
`f894c238d15916abf71fe1c05425ed8589575403`, including the subsequent local split
of live checking out of the normal profile. It is a migration ledger, not a
claim that every old test already satisfies the ownership rules above. Preserve
each row's observable behavior when replacing its implementation.

The native driver configures both editor versions for all six native targets.
Read the versions and profile list from
[`test-native-hosts.mjs`](../extension/scripts/test-native-hosts.mjs), rather than
adding an independent version list. The installed profiles cover `normal`,
`live-checking`, `regressions`, `markers`, `save-scope`, `dependencies`, `queue`,
`active-project`, `active-project-cache`, `untrusted` and `disabled`. The
`profile` and `qualification` modes are separate operator qualification tools.
They do not replace a required CI profile.

The current driver separates normal activation, navigation, templates, help,
editing and diagnostics into fresh profiles. It also separates installed
`live-checking` functional behavior from `live-performance` native component
qualification. [`host-matrix.mjs`](../extension/scripts/host-matrix.mjs) owns
the required version/profile matrix, shared by the driver and CI summaries.
[`host-profile.ts`](../extension/test/host/host-profile.ts)
validates controller profile names. Each profile has named Mocha cases through
[`host-suite.ts`](../extension/test/support/host-suite.ts), awaited ownership and
an external process supervisor. The launcher checks every owned group before
removing its workspace, user-data, extensions and controller directories.

SDK-visible workspace fixture trees belong to that external profile's physical
cleanup scope. Allocate them through the imported
[`workspace fixture owner`](../extension/test/support/workspace-fixture.ts),
which verifies native containment while preserving the selected public parent
spelling. Each case still closes its owned tabs through fresh public snapshots,
cancels and joins its work, and restores settings and original bytes. The parent
removes the trees after actual editor-host and native process-owner closure,
retains inputs when ownership is uncertain, and reports cleanup failures.

The minimum editor's
[watcher disposal](https://github.com/microsoft/vscode/blob/1.100.0/src/vs/workbench/api/common/extHostFileSystemEventService.ts)
sends an unawaited unwatch request. The
[public watcher API](https://github.com/microsoft/vscode/blob/1.100.0/src/vscode-dts/vscode.d.ts)
has no native-close acknowledgement. Component joining therefore cannot prove
all workbench filesystem consumers released a directory. The original Windows
marker failure passed all behavior and then reported `EBUSY` during inner
directory removal; its exact locking handle was unobserved. Parent removal
subsequently succeeded after SDK closure. Native filesystem errors remain
failures, and existing parent retry settings are unchanged.

The [real allocator and escape tests](../extension/test/unit/workspace-fixture.test.ts)
and [parent-lifetime regressions](../extension/test/editor-acceptance.test.mjs)
verify this boundary. Keep deliberate file deletion, junction retargeting and
per-control reset operations that establish behavior. Only terminal physical
fixture removal transfers to the external owner.

The [imported formatting caller regressions](../extension/test/unit/format-readiness.test.ts)
verify that readiness observes an early operation rejection and that body,
disposal, joining, settings, file and editor-restoration failures remain
observable together. Independent restoration attempts still run after an
earlier failure. Preserve these caller checks when changing shared cleanup
helpers or test fixtures.

| Profile or cohort | Trigger and behavior to preserve | Completion and failure controls | Owned state and replacement requirements |
| --- | --- | --- | --- |
| Normal activation and diagnostics | [`index.ts`](../extension/test/host/index.ts) opens marked roots, activates without a manual command and receives bundled CLI Jinja findings | Product activation and findings for the exact open URI; unmarked, disabled and untrusted profiles provide separate negatives | Own the opened documents and editor selection. Keep installed-product preflight separate from component initialization. |
| Normal navigation | [`navigation.ts`](../extension/test/host/navigation.ts) covers definition, hover, references, completion and impact; qualified/nested calls, Unicode/CRLF offsets, canonical aliases, dirty targets and templates | Exact provider locations, captured hashes and source preservation; stale targets, retargeted sources, invalid roots and operational failures decline safely | Own source/target buffers, alias files and providers. Replace filesystem, command and spawn patches with per-instance dependencies. Preserve canonical owner and dirty overlay checks. |
| Navigation lifecycle pilot | [`navigation-lifecycle.ts`](../extension/test/host/navigation-lifecycle.ts) cancels a credentialed query and closes its provider document | Exact argv and nonce-bound readiness, current source version/hash, cancellation result and absent fixture lifetime | Own query promises, token sources, adapter and gates. Keep a real native query cancellation check and installed-provider close check. A previous process cannot satisfy readiness. |
| Normal templates | [`templates.ts`](../extension/test/host/templates.ts) checks syntax and partial coverage for extensionless/YAML/Jinja templates; navigation, watcher refresh and configured delimiters | Exact diagnostics/locations, preserved template bytes and readonly provider results; format/Fix All/completion writes refuse | Own template aliases, task configuration and document EOL. Keep both lexical and canonical template ownership, dirty overlays, closed-context deletion and reverse alias negatives. |
| Normal help and status | [`help-status.ts`](../extension/test/host/help-status.ts), [`help-concurrency.ts`](../extension/test/host/help-concurrency.ts) render rule help, validate CLI version/registry, reflect status and share one version request across twelve overlapping commands and two roots | Registry/help content, command result, recorded child argv and exact child absence after disposal | Own help/output objects, gates and all twelve promises. Replace shared spawn/output/message patches. Preserve disposal while a registry child is held and queued work cannot start. |
| Normal writable edits | [`index.ts`](../extension/test/host/index.ts), [`safe-rule-fixes.ts`](../extension/test/host/safe-rule-fixes.ts), [`writable-ownership.ts`](../extension/test/host/writable-ownership.ts) cover quick fixes, Fix All, formatting, Unicode/CRLF endpoints and undo/redo | Expected exact buffer bytes; stale fix retains findings, template retarget refuses identical-byte writes, malformed response/cancel returns no edits | Own original buffer/disk bytes, EOL, cancellation and adapter. Retain all six pending canonical/lint-fixes/Fix All controls and stable writable positives. Restore before listeners or run directories are released. |
| Normal workspace lifecycle | [`normal-cases.ts`](../extension/test/host/normal-cases.ts) covers dirty snapshots, excluded open files, re-admission, close/rename, root setting changes, root removal, alternate formatter coexistence and related locations | Correct per-URI diagnostics; Git-ignored files stay excluded from explicit checks and formatting, restored files regain diagnostics before close clears them, stale related locations disappear, user formatter settings remain unchanged | Own rename files, formatter registrations and folder/root configuration. Each named case establishes its own starting workspace. |
| Normal project configuration | [`configuration.ts`](../extension/test/host/configuration.ts) checks saved directional namespace sharing, reverse-direction rejection, removal, dirty inline rule ignores and folder exclusions through the installed product | Register diagnostic listeners before triggers; require an unrelated real finding so temporary clearing cannot satisfy readiness. Verify dirty excluded documents, formatting/Fix All refusal, an all-excluded workspace and recovery. Imported `diagnostic-transition.test.ts` controls trigger, predicate, timeout, cancellation and cleanup failures while proving admitted work joins and listeners/timers release | Restore the original marker, close case-owned tabs, and leave new fixture trees to the external profile owner after host closure. |
| Live checking | [`live-checking.ts`](../extension/test/host/live-checking.ts) covers default-off/save parity, Unicode/CRLF current buffers, idle/sustained typing, supersession, manual/save preemption, setting-off, marker removal/restoration, template exclusion and deactivation | Thirteen recorded checkpoints, bounded invocations, exact fixture tokens and empty survivor sets; source bytes remain unchanged | Own product lifecycle, change listener, intercepted invocations and their child handles. Preserve manual/save cancellation before heavy follow-up work, all negative controls and independent cleanup errors. |
| Regressions | [`regressions.ts`](../extension/test/host/regressions.ts) preserves unrelated edits/pending format, multiple tabs, retained closed models, dirty symlink ownership, nested roots, Cloudflare grouping and stale report-bound fixes | Each labeled I1/I2/I4/I5/I6/POLICY assertion passes against its own current source/report | Own model/tab identity, pending actual CLI format, workspace folders and symlinks. No case may inherit diagnostics or action identity from its predecessor. |
| Markers and root admission | [`markers.ts`](../extension/test/host/markers.ts), [`marker-events.ts`](../extension/test/host/marker-events.ts), [`format-readiness.ts`](../extension/test/host/format-readiness.ts) and [`nested-workspace.ts`](../extension/test/host/nested-workspace.ts) cover unmarked startup, mixed roots, marker deletion/re-add, nonregular markers, nested/external overrides and YAML/Ansible transitions | Per-root diagnostics/provider availability and exact canceled process absence; edited, closed, canceled, unmarked and canonical template formatting declines | Own marker files, root settings, language transitions and adapters. Replace delayed `lstat`/watcher patches with explicit dependencies. Preserve initial readiness and final write guards as different contracts. |
| Save scope | [`save-scope.ts`](../extension/test/host/save-scope.ts) preserves startup scans, save-selected checks, unchanged explicit saves, watcher coalescing, closed bursts, late full-scan rejection and external roots | Exact recorded argv/selected paths plus retained findings/actions; typing cannot make a saved check analyze a newer dirty buffer | Own recording proxy, gate, pending saves and buffers. Keep twelve labeled scenarios, including atomic delete/create echoes and events arriving during a selected batch. |
| Dependencies | [`dependencies.ts`](../extension/test/host/dependencies.ts) covers invalid UTF-8, partial/full coverage, templates/defaults/shared Docker dependencies, membership/ignore changes, canonical aliases and dirty source status | Recorded selected requests, dependency graph status and per-URI findings; rejected context retries retain all rejected selections; visible explicit primaries retain dependencies | Own clean/dirty files, watcher subscriptions, status bars, held checks and the credential journal. First-open fixtures initially use an enclosing repository's administrative ignore outside both source roots. Remove it immediately before the first explicit check, then restore it before later renderer cases. Startup coverage cannot already own the source, and its admission must not trigger the source-root ignore watcher. Preserve unknown-source admission, alias pending status without source reads, late context changes and marker re-enablement. Split this large cohort only at independently initialized contracts. |
| Queue | [`queue.ts`](../extension/test/host/queue.ts) activates/refreshes forty open documents, coalesces keys and rejects source/settings/root invalidation while queued | All forty documents receive findings; held readiness proves queued snapshots occur only when their current check runs | Own all documents, adapter, gate and pending promises. Retain workload size, FIFO/priority behavior and every invalidation branch. |
| Active project | [`active-project.ts`](../extension/test/host/active-project.ts) preserves default-on startup overview, cached diagnostic switching, Markdown/non-file focus, hidden edits/related locations and external/aliased roots | Visible and cached findings/fixes correspond to the active owning root; hidden stale results never reappear | Own editor/tab selection, configuration, documents and any private component adapter. Keep startup full-scan intent and failed scan behavior separate from cache publication. |
| Active project cache | [`active-project.ts`](../extension/test/host/active-project.ts) additionally holds late hidden saves/closed-file results and invalidates saved related locations while hidden | Cache updates without publishing to inactive root; stale related locations cannot commit | Own recording proxy, held save promises and restoration before focus changes. Preserve controlled late completion, not only final visible findings. |
| Untrusted and disabled | [`index.ts`](../extension/test/host/index.ts), [`test-host.mjs`](../extension/scripts/test-host.mjs) exercise native restricted trust and explicitly disabled installed product | Inactive product and empty diagnostics after opening YAML | Own independent launch profiles. The restricted launch cannot inherit the ordinary test runner's trust-disable argument. |
| Formatter performance qualification | [`profile.ts`](../extension/test/host/profile.ts), [`qualification.ts`](../extension/test/host/qualification.ts) measure CLI/protocol/adapter/editor/apply phases, idempotence, idle children and resources | Six phase samples or one hundred format requests with twenty idle checkpoints; exact source hashes and final child absence | Operator-owned fixtures/output. Keep timing qualification separately runnable and record actual runtime, setup/exercise/teardown and cleanup. Linux `/proc` evidence does not establish Windows/Darwin child absence. |

The baseline host code uses global patches in navigation, live checking,
writable ownership, help concurrency, format readiness and marker observation.
Several component profiles inspect private editor fields or replace methods to
observe pending state. These are migration inputs. They must not become the
default pattern for new coverage.

## Component coverage and migration ledger

The following thirteen files retain isolated whole-module adapters or subjects
assembled from `EditorIntegration.prototype`. Their decision coverage remains
executable; they are not evidence that constructor acquisition, live
registrations or complete instance cleanup use the new ownership protocol.
The migrated host cohorts and public-constructor tests establish their own
listed contracts, without replacing every interleaving below.

| Retained family | Exact files under `extension/test/unit` | Contracts retained at the legacy boundary |
| --- | --- | --- |
| Live checking | [`live-integration.test.ts`](../extension/test/unit/live-integration.test.ts), [`live-preemption.test.ts`](../extension/test/unit/live-preemption.test.ts) | Default-off/latest-buffer behavior, eligibility controls, cross-document manual/save preemption, and the identity/rules/render/observation matrix after subprocess close. Native live profiles cover representative complete flows. |
| Logical YAML | [`logical-yaml-endpoints.test.ts`](../extension/test/unit/logical-yaml-endpoints.test.ts) | Never-saved source spelling and ownership, final awaited absence checks for every writable endpoint, disappeared physical owners, and yielded References hash/revision/admission checks. Imported provider registration removed source-fragment execution; the editor subject still bypasses its constructor. |
| Writable decisions | [`writable-ownership.test.ts`](../extension/test/unit/writable-ownership.test.ts), [`writable-stage.test.ts`](../extension/test/unit/writable-stage.test.ts) | Pre/post-operation authority and identical-byte retarget refusal; absent/passive/throwing collector parity, stage guards, and original error identity. Six real native writable controls retain their separately documented boundary. |
| Admission and templates | [`source-admission.test.ts`](../extension/test/unit/source-admission.test.ts), [`template-admission.test.ts`](../extension/test/unit/template-admission.test.ts), [`template-capabilities.test.ts`](../extension/test/unit/template-capabilities.test.ts) | Removed/escaping/retargeted source owners, fresh logical leaves, operational failures, stale unavailable admission, canonical alias refresh and template readonly policy. |
| Aliases and overlays | [`alias-events.test.ts`](../extension/test/unit/alias-events.test.ts), [`navigation-aliases.test.ts`](../extension/test/unit/navigation-aliases.test.ts), [`navigation-overlays.test.ts`](../extension/test/unit/navigation-overlays.test.ts) | Dirty canonical aliases, watcher/revision ordering, source/target overlay ownership and final snapshot/hash acceptance. The public navigation pilot retains its native and installed-provider flows. |
| Background coverage | [`background.test.ts`](../extension/test/unit/background.test.ts), [`full-coverage-retry.test.ts`](../extension/test/unit/full-coverage-retry.test.ts) | Pending/saved dependency work, rejected full-scan retry ownership, admission exclusions and selected-only retry behavior. Imported cleanup ownership removed source fragments; retained prototype controls do not prove the constructor lifecycle. |

Keep these fixtures independent. Any timer or API patch must remain serial in
its process or confined to an isolated test process, and admitted operations
must settle before restoration or file removal. A future edit to one of these
controls must migrate the relevant fixture to the real constructor and public
injected boundaries before relying on it as lifecycle evidence. Preserve its
negative matrix until the replacement demonstrates the same contract. Retained
decision coverage and completed architecture migration are separate claims.

At the inventory baseline there are 45 external TypeScript test files. Twenty
import modules directly, nineteen bundle whole modules into a VM with replaced
imports, and six execute extracted source/AST fragments. Whole-module
substitution differs from fragment execution, but both require replacement with
importable modules and explicit dependency boundaries during migration.

All filenames in the following table are under
[`extension/test/unit`](../extension/test/unit). The grouping accounts for every
baseline file. Each replacement must retain its negative interleavings and
public behavior. Keep small data validators imported directly; do not replace
them with assertions about implementation text.

| Contract group | Existing files | Existing execution and replacement obligations |
| --- | --- | --- |
| Wire and byte coordinates | `protocol`, `navigation-protocol`, `registry` | Direct imports. Preserve malformed JSON/state, duplicate/conflicting edits, exact source/hash/identity, UTF-8 to UTF-16, CRLF interior endpoints, astral characters and readonly navigation validation. Go endpoint tests remain the producer contract. |
| Queue and result state | `scheduler`, `results`, `dependencies`, `live-checks` | Direct imports. Preserve latest-wins cancellation, superseded token isolation, interactive priority, retained 40-request queues, joined cancel/dispose, selected/full coverage and dependency revisions. Inject a controllable scheduler/clock for timing decisions. |
| Native identity and observations | `identity`, `observations` | Direct imports and temporary filesystem fixtures. Preserve containment, symlinks, logical missing YAML leaves, template readonly status, same-size/restored-mtime writes and yielded read races. Keep native Windows/POSIX adapter checks. |
| Source/root admission | `canonical-authority`, `source-admission`, `template-admission`, `template-capabilities`, `template-watchers` | Whole-module VM substitutions. Migrate to constructor-supplied editor/filesystem/runner dependencies. Preserve removed/escaping/retargeted owners, latest revision fences, admitted alias ownership, unexpected operational errors, closed watches and template write refusal. |
| Background and initial coverage | `background`, `full-coverage-retry`, `startup-failure` | `background` includes AST extraction; the others use whole-module substitution. Preserve startup failure identity, original rejected promise, nonblocking admission and full/selected retry ownership. Extract admission joining into an importable owner, without reconstructing private methods in a test. |
| Alias and navigation decisions | `alias-events`, `navigation-aliases`, `navigation-marker`, `navigation-overlays`, `reference-canonical-owner` | Whole-module substitution. Preserve watcher revision races, dirty canonical aliases, deleted/retargeted markers, yielded target reads and final overlay/source hash acceptance. Use controlled deferred reads and backend results. Retain real provider registration and installed canonical-location checks. |
| Logical YAML and formatter registration | `logical-yaml-endpoints`, `formatter-source-gate` | AST-extracted provider registration plus whole-module substitution. Move provider admission/registration into an importable module. Preserve never-saved YAML source ownership, removed physical owners, asynchronous target rechecks and distinct background admission versus public writable guard. |
| Writable operations | `writable-ownership`, `writable-stage` | Whole-module substitution. Inject backend and filesystem dependencies; preserve pre/post-operation source owner, identical-byte template retargets, passive trace results and original errors. Keep actual editor undo/redo and six native host writable controls. |
| Live application/control lifecycle | `live-integration`, `live-preemption`, `live-cleanup`, `live-manual-control` | First two use whole-module substitution; latter two execute extracted host cleanup/control blocks. Directly import the cleanup/control owners and production scheduler boundary. Preserve all cleanup stages despite one failure, manual/save cancellation and fresh current findings after restoration. |
| Process and help adapters | `process`, `process-failure`, `help` | Whole-module substitution mixed with real processes. Inject narrow spawn/runner/editor dependencies. Preserve no-input versus explicit-empty-input pipes, exact raw bytes/argv, output limits, stderr/status failures, timeout/cancel/join and shared version/registry disposal. Keep actual OS ownership tests. |
| Fixed failure evidence | `cli-error-stage`, `dirty-alias-buffers`, `dirty-reference-observer`, `failure-evidence`, `first-definition-observer`, `fixture-failure-log`, `help-child`, `live-check-record`, `navigation-equality-projection`, `writable-ownership-failure` | Direct imports. Preserve bounded redacted fields, original error identity, unknown/inconclusive facts, path equality, exact operation matching and failure-path evidence. Logging failure must not replace the primary error or claim resource absence. |
| Live control evidence | `live-control-evidence` | Direct validators plus AST-extracted local host functions. Move bounded invocation/control decisions into an importable module. Keep timeout-stage reporting, all operation/control vocabularies and corrupt/oversized evidence rejection. |
| Credentialed fixture lifetime | `fixture-processes` | Direct imports. Preserve instance-token identity, complete journal membership, unknown/reset/mismatched endpoints as inconclusive, missing close deadline failure and stale/background control exclusion. Lifetime absence requires a successful observation after joined work. |

Migration follows dependency ownership: resource helpers first, navigation
pilot, writable/live operations, marker/root/template admission, then
save/dependency/queue/cache/help batches. Before removing an old test, identify
its replacement case, demonstrate the relevant bad condition fails, and review
cleanup after both success and injected failure. Preserve the workload and
operation limits. A lower case count or a framework change is not evidence of
equivalent coverage.

## Navigation coverage transfers

The navigation pilot uses `EditorIntegration(executable, adapters)` and
`validateNavigation(..., adapters)` for per-instance backend and filesystem
dependencies. `MarkedRoots` accepts its own marker-stat and watcher adapters.
`EditorIntegration.ready()` observes its current root initialization, and
`join()` observes admitted backend work. `RuleHelp` accepts the same backend
runner. A scripted runner must keep the real runner's cancellation and joining
contract; returning immediately after sending a signal is an invalid fake.

The native runner accepts a per-request environment. The ownership flag remains
enforced after that environment is merged. Test controls never mutate the
parent's environment or alter the installed package.

The following transfers remove navigation's shared API patches while retaining
the behavior they previously exercised. The production module loader in
[`navigation-fixture.ts`](../extension/test/support/navigation-fixture.ts)
substitutes only the editor-provided `vscode` module. It executes the complete
production modules and uses real files with per-instance adapters.

| Previous host control | Replacement and observable behavior |
| --- | --- |
| Manual impact backend failure, silent background refusal and redacted notice | [`navigation-injection.test.ts`](../extension/test/unit/navigation-injection.test.ts) checks a failing instance's exact calls, fixed manual notice and absence of child payload, then a separate successful instance. Dynamic answers and dirty manual targets remain quiet. The real installed `showImpact` success flow remains in [`navigation.ts`](../extension/test/host/navigation.ts). |
| Removed, symlink and directory marker before watcher delivery; first restoration | [`navigation-marker.test.ts`](../extension/test/unit/navigation-marker.test.ts) runs each replacement alone against the real marker probe and quiet instance-owned watchers. Rejection occurs before backend submission, and the first restored command succeeds without retries. |
| Edit while manual marker refresh is yielded | `navigation-marker.test.ts` holds the instance's actual marker-stat operation, edits the source and verifies the old cursor never reaches a backend. |
| Context write/event during target response validation | `navigation-injection.test.ts` controls the validator's actual read, awaits its own write/event and verifies rejection after response capture. No read can admit a background writer outside its owner. |
| Accepted provider response followed by a public dirty-target edit | `navigation-injection.test.ts` proves response ownership and next-request refusal. `navigation.ts` awaits the real second-root provider, registers its document-change listener, applies the edit, then verifies the next real request refuses the dirty target. No command interceptor changes the response. |
| Pre-cancel, admitted cancellation, source edit, disposal, close and supersession | [`navigation-lifecycle.test.ts`](../extension/test/unit/navigation-lifecycle.test.ts) controls backend closure and proves each current-generation result refuses, every cancellation listener is released and a replacement waits for the previous lane owner. |
| Forced native child cancellation and document close | [`navigation-lifecycle.ts`](../extension/test/host/navigation-lifecycle.ts) supplies local environment/nonce gates through its component adapter's runner, executes the real bundled CLI and observes exact credentialed fixture-child absence after both controls. The installed provider executes unchanged during the real public document-close flow; forced installed-provider child interception has moved to the component/native boundary. |
| Manual-control mutation/restore failure bookkeeping | [`test-resources.test.ts`](../extension/test/unit/test-resources.test.ts) covers joined deferred writes, rejected partial writes, canceled readiness and combined body/restoration failures. The navigation fixture uses that owner for complete query promises, adapter disposal/join and file removal. |
| First-definition failure observation | Real installed definitions still require exact declaration layers and coordinates. Existing first-definition evidence validators remain diagnostic-helper tests; source interception is not required for a successful navigation assertion. |

The representative installed flow retains definition, hover, references,
completion with undo, impact, dirty targets, deletion/recreation, aliases,
multi-root and configured-root behavior. The controlled component/native cases
own exhaustive ordering. Neither layer substitutes for the other.

## Importable test controllers

All six baseline source-fragment test files now execute complete modules or
imported helpers. Their actual callers use those same helpers:

| Previous fragment test | Current module and retained contract |
| --- | --- |
| `formatter-source-gate`, `logical-yaml-endpoints` | [`providers.ts`](../extension/src/providers.ts) owns provider registration. Activation and tests call its exported function. Writable/template admission, literal path selectors and provider disposal remain part of the production contract. |
| `background` | [`dependency-cleanup.ts`](../extension/test/support/dependency-cleanup.ts) disposes observation producers and the editor, joins the entire admission operation, releases subscriptions, then removes their gate/alias inputs. Its real host caller retains body and cleanup failures. Root readiness tests use a real marker and filesystem, with an isolated VS Code adapter. |
| `live-cleanup`, `live-manual-control`, `live-control-evidence` | [`live-controls.ts`](../extension/test/support/live-controls.ts) owns bounded operations, explicit cancellation state, manual/save sequencing, failure capture and cleanup. [`live-editor.ts`](../extension/test/host/live-editor.ts) owns the actual `WorkspaceEdit` adapter. Tests import these controllers or substitute only the VS Code runtime for the complete editor adapter. |

A live deadline records failure, cancels its owner and joins the losing operation.
The control owner seals launch admission on cancellation and joins admitted
actions. Cleanup attempts every stage and preserves the primary error with
independent restoration failures. Tests inject timer/cancellation errors and
abort before native readiness; they release their controlled losing operation
before accepting the final rejection.

The installed `live-checking` profile verifies real activation, default-off save
behavior, Unicode/CRLF current-buffer findings, settings and saved-byte
preservation. The separate `live-performance` profile runs beside an explicitly
disabled installed product. Its component receives real document/save/config
events and uses the verified installed backend. It retains twenty small and
twenty context-heavy samples, twenty sustained edits, the 40,000-entry primary,
4,000-entry context, all six cancellation controls and thirteen checkpoints.
It observes real process spawn/close/exit facts through its instance runner.
[`live-processes.ts`](../extension/test/support/live-processes.ts) separately
accounts for every admitted runner request and its settlement. A native
invocation starts only at a defined positive spawn PID and must close. Only
explicit cancellation before spawn with successful reservation cleanup can
complete without a child; all thirteen checkpoints require admitted requests
to equal spawned children plus those cancellations. The real gated-reservation
cases in [`live-processes.test.ts`](../extension/test/unit/live-processes.test.ts)
prove cancellation before acknowledgement and settlement after native close.
Its evidence states `component-cli-runner-spawn-and-close` and
`actualInstalledBackend`. It cannot claim installed extension event ownership.
There are no shared spawn or API patches in either live profile.

Help coverage also separates the twelve actual installed commands from twelve
held native component registry requests. Instance-local environment/nonces
control the latter and prove disposal/child absence. Installed help/status uses
public readiness and joining, with no shared output/message/spawn patches.

Dependency coverage uses an instance-local fixture environment copied into each
native invocation, an instance read boundary and the public editor completion
contract. Its alias observer subscribes to public eligibility and diagnostics;
it never replaces `check` or inspects the editor's private graph/queue maps.
Joining covers admitted work. Native filesystem events may arrive later, so
the dependency cohort observes the real production watch callback and current
ignore-file bytes before joining a membership restoration. Every callback and
duplicate still reaches the product; a prior event cannot satisfy the new
scenario's barrier.
The native cohort retains invalid UTF-8, selected/full coverage, dependency and
membership changes, aliases, first-open admission, queued ownership and all
original source/chunk workloads. [`queued-admission.test.ts`](../extension/test/unit/queued-admission.test.ts)
owns deterministic zero-copy pending-status and deduplication interleavings.
The host observes actual status items acquired through the instance's UI
factory, public status/provider membership and exact native lifetime credentials.

`EditorIntegration.join()` owns complete admitted background operations,
including saved rendering and source synchronization after backend closure. It
also waits for admitted file/refresh timers and handles work admitted during
that wait. `MarkedRoots.join()` retains probe ownership through disposal.
Disposal cancels producers and prevents later public callbacks from creating
new work. [`background-ownership.test.ts`](../extension/test/unit/background-ownership.test.ts)
uses a controlled clock and real source I/O to test these completion boundaries.
Root readiness/disposal regressions remain in
[`background.test.ts`](../extension/test/unit/background.test.ts). Readiness
joins the current root owner and its current probe, including a replacement
admitted while an older probe was pending.
[`root-readiness.test.ts`](../extension/test/unit/root-readiness.test.ts)
controls that ordering through the real editor adapter and verifies the first
format request and the edited-model rejection without retries. It also delivers
a delayed deletion notification after the current marker is already verified.
Unchanged native marker identity preserves the admitted formatter; actual
removal, replacement and rewrites still revoke that request. The installed
marker-event control also holds a real formatter through duplicate create,
change and delete notifications, then verifies that recreating the actual
marker with a different native identity still revokes ownership synchronously.
The installed
marker assertion retains its original single formatting call and records
bounded document, diagnostic and editor-event facts if it fails. Those public
facts do not expose provider invocation or cancellation internals.
User notification promises remain error-handled UI operations; backend joining
does not wait for a user to dismiss a notification.

The wider editor batches use the same boundaries:

| Feature | Current ownership and real editor coverage |
| --- | --- |
| Writable operations and formatter source gate | Six native writable controls retain their workloads. The source-read gate uses an instance's filesystem dependency and an invocation-local gate. It cannot hold another editor instance's read or infer admission from a private pending map. |
| Markers and language transitions | The installed profile retains real automatic language changes and formatting. Admit the component eagerly but leave its providers unregistered until the installed formatting lookup completes; then attach eligibility observation and register the controlled provider. This prevents the public lookup from entering its deliberately held read. The gate follows the case's operation signal so cancellation releases held reads before operation joining. Controlled ordering uses an actual registered provider through `updateProviders`' adapter; format readiness retains real native marker metadata. |
| Queues and active-project state | Forty-document queue admission remains intact. Native fixture environments belong to their runner invocation. Active-project read delays/failures use the instance filesystem; regular status and dirty-template checks observe public facts. |
| Template context and watcher exclusion | Closed-template exclusion uses an instance watcher tap and the component owner's public completion barrier, then checks actual submitted source argv. Real document-change events reach the owned component. Regular host coverage uses no private `roots` or `pendingFiles` lookup to establish that boundary. |

## Checked helper scope

The ordinary build runs strict TypeScript checks for all extension source and
TypeScript tests, plus [`tsconfig.helpers.json`](../extension/tsconfig.helpers.json)
for thirty-five JavaScript roots: fourteen build/host/ownership/publishing
scripts, nine driver/gate/publishing tests, eight executable fixtures, the shared vulnerability-test
driver, the pinned Go-tool installer, its owned output reporter and the CI
summary renderer. Each
selected JavaScript root uses `@ts-check`. Typed ESLint applies the same
floating-promise, misused-promise and awaited-value rules to these roots. The
negative gate tests check the actual compiler and lint selectors, including every selected root,
and reject discarded promises and invalid documented argument types.

The archive reader has a declared public return type. Its implementation and
the remaining packaging/release JavaScript graph are outside this checked scope.
That boundary remains explicit; transpilation, inferred JavaScript types and a
passing caller do not establish type or promise coverage for an unchecked
module. Extend the compiler and lint selectors together when bringing another
helper into the checked scope.

The shared vulnerability-test driver uses the same typed policy through the
root ESLint configuration bridge. Its cleanup refusal runs through the real
per-instance guardian control, rather than a mock of an obsolete signal path.
Scanner classification and raw failure evidence remain separate contracts.

The pinned Go-tool installer and its output reporter share that typed policy.
Their native fixture tests run in the ordinary release-driver gate on every
target. The copied Makefile pin/destination control runs through the owned Go
source gate on Linux, where the canonical Make gate runs. Explicit successful stdout/stderr
capture follows native closure and leaves existing string and exit-code
callers unchanged.

Held installer fixtures emit a bounded nonce frame on their existing owned
stdout after the native listener starts. The command's spawn observer registers
readiness before data delivery. Authenticate the fixture instance and join the
installer and its streams before removing listeners on success or failure.
Fixture readiness does not rely on a directory watcher.

The installer joins each native command owner before another attempt, and all
three possible attempts share one five-minute budget. Cancellation, exhausted
budget, uncertain cleanup and mixed output stop admission. The reporter runs as
a bounded owned child, including when its output pipe blocks. Failed installs
retain private `GOBIN/.install-evidence-*` directories with `failure.json` and
stdout/stderr files; successful installs remove their temporary evidence.

## Native and packaging contracts

| Tests or adapters | Behavior and retained platform boundary | Cleanup and failure requirements |
| --- | --- | --- |
| [`process.test.ts`](../extension/test/unit/process.test.ts), [`process-failure.test.ts`](../extension/test/unit/process-failure.test.ts), [`process.ts`](../extension/src/process.ts) | CLI stdin/EOF, raw bytes and argv, limits, cancellation and early/nonzero exit on each native target | Observe real pipe closure and owned process absence. Test before/after readiness and retained descendant pipes; injected spawn failure must retain original error identity. |
| [`release-liveness.test.mjs`](../extension/test/release-liveness.test.mjs), [`owned-command.mjs`](../extension/scripts/owned-command.mjs), [`owned-group.mjs`](../extension/scripts/owned-group.mjs) | POSIX groups, live threads/zombies and Windows kill-on-close jobs; owned output, builder deadlines and descendant pipes | Preserve denied cleanup with ordinary/nonzero/overflow/deadline failures. Unknown group or credential observations fail conservatively. POSIX thread tests require native `cc`; do not infer Windows ownership from these probes. |
| [`process-gate.test.mjs`](../extension/test/process-gate.test.mjs), [`process_fixture.go`](../extension/test/testdata/process_fixture.go) | Exact selected chunk, nonce-bound gate publication, existing readiness and fixed/redacted stage diagnostics | Fresh per-control gates; writers finish before reuse/removal. Before-stdin failures use ignored input so their intended exit cannot race a parent writer; later stages retain the private input payload. Missing executables and failed readiness must report exact fixed stages. |
| [`editor-acceptance.test.mjs`](../extension/test/editor-acceptance.test.mjs), [`editor-acceptance.ts`](../extension/test/host/editor-acceptance.ts), [`host-inputs.mjs`](../extension/scripts/host-inputs.mjs) | Requested/actual SDK identity, exact native profile forwarding and dispatch, launch arguments and independent live profile failure | Replace source-controller extraction with imported dispatch/configuration modules. Preserve failure propagation for every profile. Add installed path/version/backend/profile mismatch controls. |
| [`lint-gate.test.mjs`](../extension/test/lint-gate.test.mjs) | Compiler/promise-lint gate rejects representative unsafe async code and non-null assertion patterns | Temporary source is owned by the gate test and removed after awaited checks. Gate findings are not a substitute for process joining. |
| [`stage-release.test.mjs`](../extension/test/stage-release.test.mjs), [`package-policy.test.mjs`](../extension/test/package-policy.test.mjs), [`verify-package.mjs`](../extension/scripts/verify-package.mjs) | Staged version, removed builder paths, runtime allowlist, executable mode, explicit target and provenance | Staging owns its builder and output. Verification rejects target/identity/permissions drift before executing the package. |
| [`publish-marketplace.test.mjs`](../extension/test/publish-marketplace.test.mjs), [`publish-marketplace.mjs`](../extension/scripts/publish-marketplace.mjs) | Stable release/commit identity, source archive hash, exact eight-target manifest, package/binary hashes and complete validation before any upload | Owned disk fixtures and an injected package reader/publisher; failures preserve original errors and admit no partial batch when validation fails. The real reader remains covered by packaged acceptance; authenticated publishing requires an authorized release. |
| [`test-package.mjs`](../extension/scripts/test-package.mjs), [`test-archive.mjs`](../extension/scripts/test-archive.mjs), [`test-binary.mjs`](../extension/scripts/test-binary.mjs) | Six native archives, eight VSIXs, actual bundled CLI formatting/fix preservation/idempotence and Linux Alpine musl binaries | Verify artifact identities before probes. Keep Alpine as a binary probe, with no claim of editor-host coverage. |
| [`cmd/query_test.go`](../cmd/query_test.go), [`cmd/references_test.go`](../cmd/references_test.go), [`cmd/format_test.go`](../cmd/format_test.go), [`cmd/check_analysis_test.go`](../cmd/check_analysis_test.go) | Public producer endpoints, selected/context source identity, analysis membership and edit protocols | Go tests own temporary repositories and command I/O. Preserve failing operational states and byte/hash identity independently of TypeScript consumers. |
| [`integration/ci_test.go`](../integration/ci_test.go), [`integration/vscode_test.go`](../integration/vscode_test.go), [`integration/go_scope_test.go`](../integration/go_scope_test.go) | CI target parity, required aggregation/deadlines, task/problem matcher and current-source quality-gate scope | Configuration contract checks read actual workflow/Makefile/task inputs. They supplement execution of every required job; they cannot prove those jobs passed. |

Use Go's [testing lifecycle](https://pkg.go.dev/testing) and
[process wait contract](https://pkg.go.dev/os/exec) for backend/native fixtures.
Use [synctest](https://go.dev/blog/testing-time) only for supported in-process Go
concurrency. It cannot control Electron or external process readiness. A Go
race pass covers executed data-race paths, not all lifecycle failures.

## Running and qualifying changes

Use the pinned tools described in [contributing](contributing.md). The following
commands run from the repository root unless the block changes directory.

```sh
npm --prefix extension ci --ignore-scripts
npm --prefix extension run build
npm --prefix extension test
npm --prefix extension run test:release
npm --prefix extension run format:check
node tools/go-check.mjs go test
make docs-check
make check
```

Run a single external component file directly with the pinned external Node:

```sh
cd extension
node --experimental-strip-types --test test/unit/scheduler.test.ts
```

Build/stage local host inputs and run one development profile:

```sh
npm --prefix extension run stage:binary
npm --prefix extension run stage:test-fixture
cd extension
SALTBOX_TEST_HOST_MODE=normal npm run test:host
```

On Linux, run the host under `xvfb-run -a` when no graphical session is available.
For installed-package acceptance, first obtain matching local package artifacts
using [local packaging](extension-release.md#local-packaging), then run:

```sh
cd extension
node scripts/test-native-hosts.mjs
```

Before accepting a test change, record its trigger, exact failing condition,
observable completion, resource owner and real-platform check. Qualify shared
ownership helpers with partial setup/readiness failure, cancellation before and
after readiness, late/out-of-order completion, rejected/partial writes, early or
nonzero exit, retained pipes, surviving descendants and teardown failure. The
test must preserve original bytes/settings and both primary and cleanup errors.

Run critical component cases under twenty recorded orders and supported bounded
concurrency. Record each seed/order, actual runtimes and resource outcome.
Include cold and warm supported-host checks. Alternate ordering supplements
deterministic tests of critical interleavings; it does not prove the absence of
future failures.

Measure setup, exercise and teardown separately. Preserve existing invocation
and operation limits. The initial operational target is at least 25 percent
spare invocation time on supported runners, including setup and cleanup. This
is a project qualification target, not an upstream rule. Partition independent
work when a cohort cannot meet its budget. A budget change needs measured
evidence and review. Do not count a retry, extra sleep, shortened workload or
force-exit as acceptance.

Readiness reporting distinguishes a corrected defect, a successful exact-commit
CI run and completed stabilization qualification. Record all required
job/profile results, accepted timing and cleanup evidence, runtime/dependency
identities and remaining exceptions. Follow
[required CI coverage](extension-release.md#required-ci-coverage) before making
any completion claim.

Nested workspace ownership is also controlled by
[`root-readiness.test.ts`](../extension/test/unit/root-readiness.test.ts).
The native-path control and real directory alias keep a parent result cached,
add an unmarked child workspace, then enable its marker before allowing a fresh
check. Parent results must remain retired on both addition and removal. The
installed marker profile records distinct SDK resource and native source paths
and verifies formatting and restored parent checks through the same alias.

Native query overflow controls build the existing Go process fixture before
query admission and run it through the real `execFile` output limit. A paired
negative control blocks the Node fixture on its owned stdin pipe. The query
deadline remains one second, the cap remains 4 MiB, and every child closes before
its private build directory is removed. This separates runtime bootstrap from
the native overflow contract without weakening either failure assertion.

Template action failures retain the original assertion plus bounded public
model identity, diagnostic-code links, active resource and source status. The
provider lookup and assertions remain unchanged; evidence collection adds no
retry or readiness delay. Earlier template-action failure evidence remains
open until its specific cause is reproduced and corrected.
