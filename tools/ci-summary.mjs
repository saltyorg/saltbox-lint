// @ts-check
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hostModes, hostVersions } from "../extension/scripts/host-matrix.mjs";
import { root, targets } from "../extension/scripts/release-inputs.mjs";

/** @typedef {'check'|'native'|'acceptance'|'required'} SummaryKind */
/** @typedef {{version:string,mode:string,status:'not_run'|'running'|'passed'|'failed'}} Profile */
/** @typedef {{profiles:Profile[],status:'running'|'passed'|'failed',failure?:{stage:'download'|'profile',version:string,mode?:string}}} HostResults */
/** @typedef {{steps?:unknown,needs?:unknown,jobStatus?:string,target?:string,commit?:string,runId?:string,attempt?:string,repository?:string,serverUrl?:string,hostResults?:unknown,hostUnavailable?:string,packageMetadata?:unknown}} SummaryContext */

const evidenceLimit = 256 * 1024;
const validOutcomes = new Set(["success", "failure", "cancelled", "skipped"]);
const nativeTargets = Object.keys(targets).filter(
  (target) => !target.startsWith("alpine-"),
);
const outcomeLabels = /** @type {Record<string,string>} */ ({
  success: "Passed",
  failure: "Failed",
  cancelled: "Cancelled",
  skipped: "Not run",
});
const platformNames = /** @type {Record<string,string>} */ ({
  linux: "Linux",
  darwin: "macOS",
  win32: "Windows",
  alpine: "Alpine Linux",
});

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function escape(value) {
  return String(value)
    .slice(0, 200)
    .replaceAll(/[\r\n\u0000-\u001f\u007f]/g, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("`", "&#96;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("*", "&#42;")
    .replaceAll("_", "&#95;");
}

/** @param {string|undefined} target */
function targetName(target) {
  if (!target || !nativeTargets.includes(target)) return "unknown target";
  const [platform, architecture] = target.split("-");
  return `${platformNames[platform]} ${architecture === "x64" ? "amd64" : "arm64"}`;
}

/** @param {unknown} steps @param {string} id */
function outcome(steps, id) {
  const step = record(steps) ? steps[id] : undefined;
  return record(step) &&
    typeof step.outcome === "string" &&
    validOutcomes.has(step.outcome)
    ? step.outcome
    : "unavailable";
}

/** @param {string[]} states @param {string|undefined} jobStatus */
function result(states, jobStatus) {
  if (jobStatus === "cancelled" || states.includes("cancelled"))
    return "Cancelled";
  if (jobStatus === "failure" || states.includes("failure")) return "Failed";
  return states.length > 0 && states.every((state) => state === "success")
    ? "Passed"
    : "Incomplete";
}

/** @param {SummaryContext} context */
function runURL(context) {
  const server = context.serverUrl ?? "https://github.com";
  try {
    const url = new URL(server);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[\w.-]+\/[\w.-]+$/.test(`/${context.repository ?? ""}`) ||
      !/^\d+$/.test(context.runId ?? "")
    )
      return undefined;
    url.pathname = `/${context.repository}/actions/runs/${context.runId}${/^\d+$/.test(context.attempt ?? "") ? `/attempts/${context.attempt}` : ""}`;
    return url.href;
  } catch {
    return undefined;
  }
}

/** @param {SummaryContext} context */
function identity(context) {
  const sha = /^[a-f0-9]{40}$/.test(context.commit ?? "")
    ? context.commit
    : undefined;
  const run = runURL(context);
  const commitURL = run && sha ? new URL(run) : undefined;
  if (commitURL) commitURL.pathname = `/${context.repository}/commit/${sha}`;
  const tested = sha
    ? `Commit ${commitURL ? `[${sha.slice(0, 7)}](${commitURL.href})` : sha.slice(0, 7)}`
    : "Commit unavailable";
  const attempt = /^\d+$/.test(context.attempt ?? "")
    ? context.attempt
    : "unavailable";
  return run
    ? `${tested} · [Run attempt ${attempt}](${run}).`
    : `${tested}; attempt ${attempt}.`;
}

/** @param {SummaryContext} context @param {string} id */
function artifactURL(context, id) {
  if (outcome(context.steps, id) !== "success" || !record(context.steps))
    return undefined;
  const step = context.steps[id];
  const value =
    record(step) && record(step.outputs)
      ? step.outputs["artifact-url"]
      : undefined;
  const run = runURL(context);
  if (typeof value !== "string" || !run) return undefined;
  try {
    const url = new URL(value);
    const expected = new URL(run);
    return url.origin === expected.origin &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      new RegExp(
        `^/${context.repository?.replaceAll(".", "\\.")}/actions/runs/${context.runId}/artifacts/[0-9]+$`,
      ).test(url.pathname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** @param {unknown} value @param {SummaryContext} context @returns {HostResults|undefined} */
function hostResults(value, context) {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.target !== context.target ||
    value.commit !== context.commit ||
    value.runId !== context.runId ||
    value.attempt !== context.attempt ||
    !/^[a-f0-9]{40}$/.test(context.commit ?? "") ||
    !/^\d+$/.test(context.runId ?? "") ||
    !/^\d+$/.test(context.attempt ?? "") ||
    !nativeTargets.includes(context.target ?? "")
  )
    return undefined;
  if (
    !Array.isArray(value.versions) ||
    !Array.isArray(value.modes) ||
    JSON.stringify(value.versions) !== JSON.stringify(hostVersions) ||
    JSON.stringify(value.modes) !== JSON.stringify(hostModes) ||
    !Array.isArray(value.profiles) ||
    value.profiles.length !== hostVersions.length * hostModes.length ||
    typeof value.status !== "string" ||
    !["running", "passed", "failed"].includes(value.status)
  )
    return undefined;
  /** @type {Profile[]} */
  const profiles = [];
  const membership = new Set();
  let unfinished = false;
  for (const entry of value.profiles) {
    if (
      !record(entry) ||
      typeof entry.version !== "string" ||
      typeof entry.mode !== "string" ||
      !hostVersions.includes(entry.version) ||
      !hostModes.includes(entry.mode) ||
      typeof entry.status !== "string" ||
      !["not_run", "running", "passed", "failed"].includes(entry.status)
    )
      return undefined;
    const key = `${entry.version}/${entry.mode}`;
    if (membership.has(key)) return undefined;
    membership.add(key);
    if (unfinished && entry.status !== "not_run") return undefined;
    if (entry.status !== "passed") unfinished = true;
    profiles.push({
      version: entry.version,
      mode: entry.mode,
      status: /** @type {Profile['status']} */ (entry.status),
    });
  }
  if (
    profiles.some(
      (entry, index) =>
        entry.version !== hostVersions[Math.floor(index / hostModes.length)] ||
        entry.mode !== hostModes[index % hostModes.length],
    )
  )
    return undefined;
  const running = profiles.filter((entry) => entry.status === "running");
  const failed = profiles.filter((entry) => entry.status === "failed");
  if (
    running.length > 1 ||
    failed.length > 1 ||
    (running.length && failed.length) ||
    (value.status === "passed" && unfinished) ||
    (value.status === "running" && failed.length) ||
    (value.status === "failed" && running.length)
  )
    return undefined;
  /** @type {HostResults['failure']} */
  let failure;
  if (value.failure !== undefined) {
    const item = value.failure;
    if (
      !record(item) ||
      value.status !== "failed" ||
      typeof item.version !== "string" ||
      !hostVersions.includes(item.version) ||
      typeof item.stage !== "string" ||
      !["download", "profile"].includes(item.stage)
    )
      return undefined;
    if (item.stage === "download" && (item.mode !== undefined || failed.length))
      return undefined;
    if (item.stage === "download") {
      const failedVersion = hostVersions.indexOf(item.version);
      if (
        profiles.some((entry) =>
          hostVersions.indexOf(entry.version) < failedVersion
            ? entry.status !== "passed"
            : entry.status !== "not_run",
        )
      )
        return undefined;
    }
    if (
      item.stage === "profile" &&
      (typeof item.mode !== "string" ||
        failed.length !== 1 ||
        failed[0].version !== item.version ||
        failed[0].mode !== item.mode)
    )
      return undefined;
    failure = {
      stage: /** @type {'download'|'profile'} */ (item.stage),
      version: item.version,
      ...(typeof item.mode === "string" ? { mode: item.mode } : {}),
    };
  } else if (value.status === "failed") {
    return undefined;
  }
  return {
    profiles,
    status: /** @type {HostResults['status']} */ (value.status),
    ...(failure ? { failure } : {}),
  };
}

/** @param {string[][]} rows */
function table(rows) {
  return [
    "| Check | Result |",
    "| --- | --- |",
    ...rows.map(([label, state]) => `| ${escape(label)} | ${escape(state)} |`),
  ].join("\n");
}

/** @param {SummaryContext} context */
function packageCounts(context) {
  const metadata = context.packageMetadata;
  if (
    outcome(context.steps, "build_package") !== "success" ||
    !record(metadata) ||
    metadata.commit !== context.commit ||
    !Array.isArray(metadata.packages) ||
    metadata.packages.length !== Object.keys(targets).length
  )
    return undefined;
  const included = new Set();
  for (const item of metadata.packages) {
    if (
      !record(item) ||
      typeof item.target !== "string" ||
      !Object.hasOwn(targets, item.target) ||
      included.has(item.target) ||
      typeof item.filename !== "string" ||
      !item.filename.endsWith(".vsix") ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      return undefined;
    included.add(item.target);
  }
  return `Verified ${nativeTargets.length} CLI archives and ${included.size} platform VSIX packages. Native and installed editor qualification is reported by their own jobs.`;
}

/** @param {SummaryKind} kind @param {SummaryContext} context */
export function renderSummary(kind, context) {
  /** @type {[string,string,boolean?][]} */
  let checks;
  const windows = context.target?.startsWith("win32-") === true;
  const linux = context.target?.startsWith("linux-") === true;
  const preparation = /** @type {[string,string,boolean?][]} */ ([
    ["checkout", "Checkout"],
    ["go_setup", "Go setup"],
    ["node_setup", "Node setup"],
    ["npm_setup", "npm setup"],
  ]);
  if (kind === "required") {
    checks = [
      ["check", "Build and package"],
      ["native", "Native source checks"],
      ["acceptance", "Installed package acceptance"],
    ];
  } else if (kind === "check") {
    checks = [
      ...preparation,
      ["build_package", "Quality gate and package verification"],
      ["source_rebuild", "Offline source rebuild"],
      ["vulnerability_upload", "Vulnerability evidence upload"],
      ["release_upload", "Package artifact upload"],
    ];
  } else if (kind === "native") {
    checks = [
      ...preparation,
      ["architecture", "Runner architecture"],
      ["windows_launcher", "Windows process launcher", !windows],
      ["go_tests", "Go tests"],
      ["nuri_tests", "Patched Nuri tests"],
      ["go_race", "Go race tests", context.target === "win32-arm64"],
      [
        "nuri_race",
        "Patched Nuri race tests",
        context.target === "win32-arm64",
      ],
      ["vet_lint", "Go vet and lint"],
      ["dependencies", "Extension dependencies"],
      ["build", "Extension build and type checks"],
      ["unit_tests", "Extension unit tests"],
      ["release_tests", "Extension release tests"],
      ["format", "Extension formatting"],
    ];
  } else if (kind === "acceptance") {
    checks = [
      ...preparation,
      ["download_artifacts", "Package download"],
      ["package_tests", "Packaged CLI tests"],
      ["editor_dependencies", "Linux editor dependencies", !linux],
      ["editor_tests", "Installed editor tests"],
      ["alpine", "Alpine packaged CLI tests", !linux],
    ];
  } else {
    throw new Error(`Unknown CI summary kind: ${kind}`);
  }
  const states = checks.map(([id, , omitted]) => {
    if (
      omitted &&
      ["skipped", "unavailable"].includes(outcome(context.steps, id))
    )
      return "not_applicable";
    if (kind !== "required") return outcome(context.steps, id);
    const dependency = record(context.needs) ? context.needs[id] : undefined;
    return record(dependency) &&
      typeof dependency.result === "string" &&
      validOutcomes.has(dependency.result)
      ? dependency.result
      : "unavailable";
  });
  const actual =
    kind === "acceptance"
      ? hostResults(context.hostResults, context)
      : undefined;
  const requiredSteps = [
    ["checkout", "Required job checkout"],
    ["node_setup", "Required job Node setup"],
    ["gate", "Required job gate"],
  ];
  const requiredStates =
    kind === "required"
      ? requiredSteps.map(([id]) => outcome(context.steps, id))
      : [];
  let status = result(
    [
      ...states.filter((state) => state !== "not_applicable"),
      ...requiredStates,
    ],
    context.jobStatus,
  );
  if (
    kind === "acceptance" &&
    actual?.status === "failed" &&
    status !== "Cancelled"
  )
    status = "Failed";
  if (
    kind === "acceptance" &&
    status === "Passed" &&
    (!actual || actual.status !== "passed")
  )
    status = "Incomplete";
  const title =
    kind === "required"
      ? `CI ${status.toLowerCase()}`
      : `${kind === "check" ? "Build and package" : kind === "native" ? "Native checks" : "Installed package acceptance"} ${status.toLowerCase()}${kind === "check" ? "" : ` on ${targetName(context.target)}`}`;
  let rows = checks.map(([id, label], index) => [
    label,
    states[index] === "not_applicable"
      ? id.includes("race")
        ? "Unavailable on Windows arm64"
        : "Not applicable"
      : (outcomeLabels[states[index]] ?? "Unavailable"),
  ]);
  if (kind === "required") {
    rows.push(
      ...requiredSteps.flatMap(([, label], index) =>
        requiredStates[index] === "success"
          ? []
          : [[label, outcomeLabels[requiredStates[index]] ?? "Unavailable"]],
      ),
    );
  } else {
    const preparationStates = states.slice(0, preparation.length);
    const setupStatus = result(preparationStates, undefined);
    rows = [
      ["Setup", setupStatus],
      ...rows.filter(
        (_, index) =>
          index >= preparation.length || states[index] !== "success",
      ),
    ];
  }
  const lines = [`## ${title}`, "", identity(context), "", table(rows)];
  if (kind === "required") {
    const configured =
      nativeTargets.length * hostVersions.length * hostModes.length;
    lines.push(
      "",
      `Configured coverage: Linux, macOS and Windows on amd64 and arm64; ${nativeTargets.length} native targets × ${hostVersions.length} editor versions × ${hostModes.length} profiles = ${configured} installed editor profiles. These are configured totals; actual completion appears in each target's summary.`,
      "",
      "Coverage limits: Windows arm64 has no Go race runtime. Alpine amd64 and arm64 receive packaged CLI probes, without an editor host suite.",
    );
  }
  if (kind === "check") {
    const counts = packageCounts(context);
    lines.push(
      "",
      counts ??
        `Configured package targets: ${nativeTargets.length} CLI archives and ${Object.keys(targets).length} platform VSIX packages. Verified package inventory is unavailable in this summary.`,
    );
    const links = [
      ["release_upload", "Download packages"],
      ["vulnerability_upload", "Vulnerability evidence"],
    ].flatMap(([id, label]) => {
      const url = artifactURL(context, id);
      return url ? [`[${label}](${url})`] : [];
    });
    if (links.length) lines.push("", links.join(" · "));
  }
  if (kind === "acceptance") {
    lines.push("", "### Installed editor profiles", "");
    if (!actual) {
      lines.push(
        `Profile evidence unavailable${context.hostUnavailable ? `: ${escape(context.hostUnavailable)}` : ": missing or invalid checkpoint for this target, commit and run attempt"}. The editor step outcome does not establish completed profile coverage.`,
      );
    } else {
      lines.push(
        "| VS Code | Passed | Failed | Running | Not run |",
        "| --- | ---: | ---: | ---: | ---: |",
      );
      for (const version of hostVersions) {
        const profiles = actual.profiles.filter(
          (entry) => entry.version === version,
        );
        lines.push(
          `| ${escape(version)} | ${["passed", "failed", "running", "not_run"].map((state) => profiles.filter((entry) => entry.status === state).length).join(" | ")} |`,
        );
      }
      if (actual.failure)
        lines.push(
          "",
          actual.failure.stage === "download"
            ? `Editor download failed for VS Code ${escape(actual.failure.version)}.`
            : `Failed profile: VS Code ${escape(actual.failure.version)}, ${escape(actual.failure.mode)}.`,
        );
      if (
        actual.status !== "passed" ||
        outcome(context.steps, "editor_tests") !== "success"
      )
        lines.push("", "Installed editor coverage is incomplete.");
      lines.push(
        "",
        "<details>",
        "<summary>Profile results</summary>",
        "",
        "| VS Code | Profile | Result |",
        "| --- | --- | --- |",
      );
      for (const entry of actual.profiles)
        lines.push(
          `| ${escape(entry.version)} | ${escape(entry.mode)} | ${{ passed: "Passed", failed: "Failed", running: "Running", not_run: "Not run" }[entry.status]} |`,
        );
      lines.push("", "</details>");
    }
  }
  return lines.join("\n") + "\n";
}

/** @param {string|undefined} path @returns {unknown} */
function readEvidence(path) {
  if (!path) throw new Error("checkpoint was not supplied");
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > evidenceLimit
  )
    throw new Error("checkpoint is not a bounded regular file");
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > evidenceLimit
    )
      throw new Error("checkpoint identity changed");
    const bytes = Buffer.alloc(evidenceLimit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (count === 0) break;
      length += count;
    }
    if (length > evidenceLimit)
      throw new Error("checkpoint exceeded the size limit");
    return /** @type {unknown} */ (
      JSON.parse(bytes.subarray(0, length).toString("utf8"))
    );
  } finally {
    closeSync(descriptor);
  }
}

/** @param {string|undefined} text @returns {Record<string,unknown>} */
function parseContext(text) {
  if (!text || Buffer.byteLength(text) > evidenceLimit)
    throw new Error("CI summary context is missing or exceeds 256 KiB");
  try {
    const value = /** @type {unknown} */ (JSON.parse(text));
    if (!record(value)) throw new Error("CI summary context must be an object");
    return value;
  } catch {
    throw new Error("CI summary context is malformed or is not an object");
  }
}

/** @param {SummaryKind} kind @param {NodeJS.ProcessEnv} [environment] */
export function writeSummary(kind, environment = process.env) {
  /** @type {SummaryContext} */
  const context = {
    jobStatus: environment.CI_SUMMARY_JOB_STATUS,
    target: environment.CI_SUMMARY_TARGET,
    commit: environment.GITHUB_SHA,
    runId: environment.GITHUB_RUN_ID,
    attempt: environment.GITHUB_RUN_ATTEMPT,
    repository: environment.GITHUB_REPOSITORY,
    serverUrl: environment.GITHUB_SERVER_URL,
  };
  /** @type {Error|undefined} */
  let reportingError;
  try {
    context.steps = parseContext(environment.CI_SUMMARY_STEPS);
  } catch (error) {
    reportingError =
      error instanceof Error
        ? error
        : new Error("CI summary context is unavailable");
  }
  if (kind === "required") {
    try {
      context.needs = parseContext(environment.CI_SUMMARY_NEEDS);
    } catch (error) {
      reportingError ??=
        error instanceof Error
          ? error
          : new Error("CI summary context is unavailable");
    }
  }
  if (kind === "acceptance") {
    try {
      context.hostResults = readEvidence(environment.CI_SUMMARY_HOST_RESULTS);
    } catch {
      context.hostUnavailable =
        "checkpoint is missing, unreadable, malformed or exceeds 256 KiB";
    }
  }
  if (kind === "check") {
    try {
      context.packageMetadata = readEvidence(
        resolve(root, "dist/vsix-artifacts.json"),
      );
    } catch {
      /* Optional package detail cannot replace the gate outcome. */
    }
  }
  const markdown = renderSummary(kind, context);
  if (environment.GITHUB_STEP_SUMMARY)
    appendFileSync(environment.GITHUB_STEP_SUMMARY, markdown, "utf8");
  else process.stdout.write(markdown);
  if (
    !reportingError &&
    kind === "acceptance" &&
    outcome(context.steps, "editor_tests") === "success" &&
    hostResults(context.hostResults, context)?.status !== "passed"
  )
    reportingError = new Error(
      "The editor test step succeeded without valid completed profile evidence for this target, commit and run attempt",
    );
  if (reportingError) throw reportingError;
  return markdown;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const kind = process.argv[2];
  if (!["check", "native", "acceptance", "required"].includes(kind))
    throw new Error(
      "Expected summary kind: check, native, acceptance or required",
    );
  writeSummary(/** @type {SummaryKind} */ (kind));
}
