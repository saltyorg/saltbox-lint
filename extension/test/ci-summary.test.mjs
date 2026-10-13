// @ts-check
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { renderSummary, writeSummary } from "../../tools/ci-summary.mjs";
import { hostModes, hostVersions } from "../scripts/host-matrix.mjs";
import { targets } from "../scripts/release-inputs.mjs";

/** @typedef {import('../../tools/ci-summary.mjs').SummaryContext} SummaryContext */
const commit = "0123456789abcdef0123456789abcdef01234567";
const base = {
  commit,
  runId: "123",
  attempt: "2",
  repository: "saltyorg/saltbox-lint",
  serverUrl: "https://github.com",
  jobStatus: "success",
};
const setup = ["checkout", "go_setup", "node_setup", "npm_setup"];
const acceptance = [
  ...setup,
  "download_artifacts",
  "package_tests",
  "editor_dependencies",
  "editor_tests",
  "alpine",
];

/** @param {string[]} ids */
function passed(ids) {
  return Object.fromEntries(
    ids.map((id) => [id, { outcome: "success", conclusion: "success" }]),
  );
}

function completedHosts() {
  return {
    schemaVersion: 1,
    target: "linux-x64",
    commit,
    runId: "123",
    attempt: "2",
    versions: [...hostVersions],
    modes: [...hostModes],
    status: "passed",
    profiles: hostVersions.flatMap((version) =>
      hostModes.map((mode) => ({ version, mode, status: "passed" })),
    ),
  };
}

/** @param {import('node:test').TestContext} t */
function directory(t) {
  const destination = mkdtempSync(
    join(
      process.env.SALTBOX_TEST_WORKSPACE_BASE ?? tmpdir(),
      "saltbox-ci-summary-",
    ),
  );
  t.after(() => rmSync(destination, { recursive: true, force: true }));
  return destination;
}

test("required summary leads with outcomes and labels configured cross-platform coverage", () => {
  const markdown = renderSummary("required", {
    ...base,
    steps: passed(["checkout", "node_setup", "gate"]),
    needs: {
      check: { result: "success" },
      native: { result: "success" },
      acceptance: { result: "success" },
    },
  });
  assert.match(markdown, /^## CI passed\n/);
  assert.match(
    markdown,
    /Commit \[0123456\]\(https:\/\/github.com\/saltyorg\/saltbox-lint\/commit\/0123456789abcdef0123456789abcdef01234567\)/,
  );
  assert.match(
    markdown,
    /\[Run attempt 2\]\(https:\/\/github.com\/saltyorg\/saltbox-lint\/actions\/runs\/123\/attempts\/2\)/,
  );
  assert.match(markdown, /Linux, macOS and Windows on amd64 and arm64/);
  assert.match(
    markdown,
    /Configured coverage:.*6 native targets × 2 editor versions × 17 profiles = 204/,
  );
  assert.match(markdown, /These are configured totals/);
  assert.match(markdown, /Windows arm64 has no Go race runtime/);
  assert.match(markdown, /Alpine.*without an editor host suite/);
  assert.doesNotMatch(markdown, /204.*passed|production ready|release ready/i);
});

test("required summary never turns failed, cancelled, skipped or missing jobs into success", () => {
  for (const state of [
    "failure",
    "cancelled",
    "skipped",
    undefined,
    "unexpected",
  ]) {
    const markdown = renderSummary("required", {
      ...base,
      steps: passed(["checkout", "node_setup", "gate"]),
      needs: {
        check: { result: "success" },
        native: state ? { result: state } : {},
        acceptance: { result: "success" },
      },
    });
    assert.doesNotMatch(markdown, /^## CI passed/);
    assert.match(
      markdown,
      /\| Native source checks \| (Failed|Cancelled|Not run|Unavailable) \|/,
    );
  }
});

test("required summary explains its own setup or gate failure when dependencies passed", (t) => {
  const needs = {
    check: { result: "success" },
    native: { result: "success" },
    acceptance: { result: "success" },
  };
  for (const [id, label] of [
    ["checkout", "Required job checkout"],
    ["node_setup", "Required job Node setup"],
    ["gate", "Required job gate"],
  ]) {
    const steps = {
      ...passed(["checkout", "node_setup", "gate"]),
      [id]: { outcome: "failure" },
    };
    const markdown = renderSummary("required", { ...base, needs, steps });
    assert.match(markdown, /^## CI failed/);
    assert.ok(markdown.includes(`| ${label} | Failed |`));
    assert.match(markdown, /Native source checks \| Passed/);
  }
  const destination = join(directory(t), "summary.md");
  const steps = {
    ...passed(["checkout", "node_setup", "gate"]),
    gate: { outcome: "failure" },
  };
  writeSummary("required", {
    GITHUB_STEP_SUMMARY: destination,
    CI_SUMMARY_STEPS: JSON.stringify(steps),
    CI_SUMMARY_NEEDS: JSON.stringify(needs),
  });
  assert.match(readFileSync(destination, "utf8"), /^## CI failed/);
  assert.match(
    readFileSync(destination, "utf8"),
    /Required job gate \| Failed/,
  );
});

test("successful preparation collapses to one row while setup problems remain explicit", () => {
  const steps = passed([
    ...setup,
    "build_package",
    "source_rebuild",
    "vulnerability_upload",
    "release_upload",
  ]);
  const passedSummary = renderSummary("check", { ...base, steps });
  assert.match(passedSummary, /\| Setup \| Passed \|/);
  assert.doesNotMatch(
    passedSummary,
    /\| Checkout \||\| Go setup \||\| Node setup \||\| npm setup \|/,
  );
  for (const [state, label] of [
    ["failure", "Failed"],
    ["skipped", "Not run"],
    ["unknown", "Unavailable"],
  ]) {
    const failedSummary = renderSummary("check", {
      ...base,
      steps: { ...steps, node_setup: { outcome: state } },
    });
    assert.doesNotMatch(failedSummary, /^## Build and package passed/);
    assert.ok(failedSummary.includes(`| Node setup | ${label} |`));
    assert.doesNotMatch(failedSummary, /\| Checkout \|/);
  }
});

test("step outcomes retain failures hidden by continue-on-error", () => {
  const steps = passed([
    ...setup,
    "build_package",
    "source_rebuild",
    "vulnerability_upload",
    "release_upload",
  ]);
  steps.build_package = { outcome: "failure", conclusion: "success" };
  const markdown = renderSummary("check", { ...base, steps });
  assert.match(markdown, /^## Build and package failed/);
  assert.match(markdown, /Quality gate and package verification \| Failed/);
});

test("native summaries distinguish intentional omissions from checks that did not run", () => {
  const ids = [
    ...setup,
    "architecture",
    "go_tests",
    "nuri_tests",
    "vet_lint",
    "dependencies",
    "build",
    "unit_tests",
    "release_tests",
    "format",
  ];
  const windows = renderSummary("native", {
    ...base,
    target: "win32-arm64",
    steps: passed([...ids, "windows_launcher"]),
  });
  assert.match(windows, /^## Native checks passed on Windows arm64/);
  assert.match(windows, /Go race tests \| Unavailable on Windows arm64/);
  assert.match(
    windows,
    /Patched Nuri race tests \| Unavailable on Windows arm64/,
  );
  const mac = renderSummary("native", {
    ...base,
    target: "darwin-arm64",
    steps: passed([...ids, "go_race", "nuri_race"]),
  });
  assert.match(mac, /^## Native checks passed on macOS arm64/);
  assert.match(mac, /Windows process launcher \| Not applicable/);
  const missing = renderSummary("native", {
    ...base,
    target: "win32-x64",
    steps: passed([...ids, "windows_launcher"]),
  });
  assert.match(missing, /^## Native checks incomplete on Windows amd64/);
  assert.match(missing, /Go race tests \| Unavailable/);
});

test("acceptance summary reports actual per-editor completion", () => {
  const markdown = renderSummary("acceptance", {
    ...base,
    target: "linux-x64",
    steps: passed(acceptance),
    hostResults: completedHosts(),
  });
  assert.match(
    markdown,
    /^## Installed package acceptance passed on Linux amd64/,
  );
  for (const version of hostVersions)
    assert.ok(markdown.includes(`| ${version} | 17 | 0 | 0 | 0 |`));
  assert.match(markdown, /<details>\n<summary>Profile results<\/summary>/);
  assert.doesNotMatch(markdown, /coverage is incomplete|evidence unavailable/);
});

test("partial profile failure shows completed, failed and unrun counts and the failed case", () => {
  const hosts = completedHosts();
  hosts.status = "failed";
  hosts.profiles.forEach((profile, index) => {
    profile.status = index < 2 ? "passed" : index === 2 ? "failed" : "not_run";
  });
  const failure = {
    stage: "profile",
    version: hosts.profiles[2].version,
    mode: hosts.profiles[2].mode,
  };
  const steps = passed(acceptance);
  steps.editor_tests = { outcome: "failure", conclusion: "failure" };
  const markdown = renderSummary("acceptance", {
    ...base,
    target: "linux-x64",
    steps,
    hostResults: { ...hosts, failure },
    jobStatus: "failure",
  });
  assert.match(markdown, /^## Installed package acceptance failed/);
  assert.ok(markdown.includes(`| ${hostVersions[0]} | 2 | 1 | 0 | 14 |`));
  assert.ok(markdown.includes(`| ${hostVersions[1]} | 0 | 0 | 0 | 17 |`));
  assert.ok(
    markdown.includes(
      `Failed profile: VS Code ${failure.version}, ${failure.mode}.`,
    ),
  );
  assert.match(markdown, /coverage is incomplete/);
});

test("cancelled acceptance preserves the running checkpoint without claiming a completed profile", () => {
  const hosts = completedHosts();
  hosts.status = "running";
  hosts.profiles.forEach((profile, index) => {
    profile.status = index === 0 ? "running" : "not_run";
  });
  const steps = passed(acceptance);
  steps.editor_tests = { outcome: "cancelled", conclusion: "cancelled" };
  const markdown = renderSummary("acceptance", {
    ...base,
    target: "linux-x64",
    steps,
    hostResults: hosts,
    jobStatus: "cancelled",
  });
  assert.match(markdown, /^## Installed package acceptance cancelled/);
  assert.ok(markdown.includes(`| ${hostVersions[0]} | 0 | 0 | 1 | 16 |`));
  assert.match(markdown, /coverage is incomplete/);
});

test("failed editor download identifies the unavailable version while retaining prior completions", () => {
  const hosts = completedHosts();
  hosts.status = "failed";
  hosts.profiles.forEach((profile) => {
    if (profile.version === hostVersions[1]) profile.status = "not_run";
  });
  const markdown = renderSummary("acceptance", {
    ...base,
    target: "linux-x64",
    steps: passed(acceptance),
    hostResults: {
      ...hosts,
      failure: { stage: "download", version: hostVersions[1] },
    },
  });
  assert.match(markdown, /^## Installed package acceptance failed/);
  assert.ok(
    markdown.includes(`Editor download failed for VS Code ${hostVersions[1]}.`),
  );
  assert.ok(markdown.includes(`| ${hostVersions[1]} | 0 | 0 | 0 | 17 |`));
});

test("missing, stale, duplicate and inconsistent checkpoints cannot establish editor success", () => {
  const valid = completedHosts();
  const duplicate = {
    ...valid,
    profiles: [valid.profiles[0], ...valid.profiles.slice(0, -1)],
  };
  const inconsistent = {
    ...valid,
    status: "passed",
    profiles: valid.profiles.map((profile, index) => ({
      ...profile,
      status: index === 0 ? "not_run" : "passed",
    })),
  };
  const wrongDownload = {
    ...valid,
    status: "failed",
    failure: { stage: "download", version: hostVersions[0] },
    profiles: valid.profiles.map((profile, index) => ({
      ...profile,
      status: index === 0 ? "passed" : "not_run",
    })),
  };
  for (const evidence of [
    undefined,
    { ...valid, commit: "f".repeat(40) },
    { ...valid, attempt: "1" },
    { ...valid, target: "win32-arm64" },
    { ...valid, runId: "122" },
    { ...valid, schemaVersion: 2 },
    { ...valid, profiles: valid.profiles.slice(1) },
    duplicate,
    inconsistent,
    wrongDownload,
  ]) {
    const markdown = renderSummary("acceptance", {
      ...base,
      target: "linux-x64",
      steps: passed(acceptance),
      hostResults: evidence,
    });
    assert.match(markdown, /^## Installed package acceptance incomplete/);
    assert.match(markdown, /Profile evidence unavailable/);
    assert.doesNotMatch(markdown, /\| 17 \| 0 \| 0 \| 0 \|/);
  }
});

test("checkpoint enums and sequential progress reject coerced or impossible observations", (t) => {
  const valid = completedHosts();
  const lateRunning = {
    ...valid,
    status: "running",
    profiles: valid.profiles.map((profile, index) => ({
      ...profile,
      status: index === 1 ? "running" : "not_run",
    })),
  };
  const lateFailed = {
    ...lateRunning,
    status: "failed",
    failure: {
      stage: "profile",
      version: valid.profiles[1].version,
      mode: valid.profiles[1].mode,
    },
    profiles: lateRunning.profiles.map((profile, index) => ({
      ...profile,
      status: index === 1 ? "failed" : "not_run",
    })),
  };
  const malformed = [
    { ...valid, status: ["passed"] },
    {
      ...valid,
      status: "running",
      profiles: valid.profiles.map((profile, index) => ({
        ...profile,
        status: index === valid.profiles.length - 1 ? ["not_run"] : "passed",
      })),
    },
    {
      ...valid,
      status: "failed",
      failure: {
        stage: ["profile"],
        version: valid.profiles[0].version,
        mode: valid.profiles[0].mode,
      },
      profiles: valid.profiles.map((profile, index) => ({
        ...profile,
        status: index === 0 ? "failed" : "not_run",
      })),
    },
    lateRunning,
    lateFailed,
    {
      ...valid,
      status: "failed",
      failure: { stage: "download", version: hostVersions[1] },
    },
  ];
  const owned = directory(t);
  const checkpoint = join(owned, "invalid-hosts.json");
  const destination = join(owned, "summary.md");
  for (const evidence of malformed) {
    const markdown = renderSummary("acceptance", {
      ...base,
      target: "linux-x64",
      steps: passed(acceptance),
      hostResults: evidence,
    });
    assert.match(markdown, /Profile evidence unavailable/);
    assert.doesNotMatch(markdown, /\| 17 \| 0 \| 0 \| 0 \|/);
    writeFileSync(checkpoint, JSON.stringify(evidence));
    assert.throws(
      () =>
        writeSummary("acceptance", {
          GITHUB_SHA: commit,
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_REPOSITORY: base.repository,
          GITHUB_SERVER_URL: base.serverUrl,
          GITHUB_STEP_SUMMARY: destination,
          CI_SUMMARY_TARGET: "linux-x64",
          CI_SUMMARY_STEPS: JSON.stringify(passed(acceptance)),
          CI_SUMMARY_HOST_RESULTS: checkpoint,
        }),
      /without valid completed profile evidence/,
    );
  }
});

test("all passed profiles before final checkpoint publication retain their actual observations", () => {
  const steps = { ...passed(acceptance), editor_tests: { outcome: "failure" } };
  const markdown = renderSummary("acceptance", {
    ...base,
    target: "linux-x64",
    steps,
    hostResults: { ...completedHosts(), status: "running" },
  });
  assert.match(markdown, /^## Installed package acceptance failed/);
  assert.doesNotMatch(markdown, /Profile evidence unavailable/);
  for (const version of hostVersions)
    assert.ok(markdown.includes(`| ${version} | 17 | 0 | 0 | 0 |`));
  assert.match(markdown, /coverage is incomplete/);
});

test("non-Linux acceptance labels Linux preparation and Alpine probes as not applicable", () => {
  const hosts = { ...completedHosts(), target: "darwin-x64" };
  const markdown = renderSummary("acceptance", {
    ...base,
    target: "darwin-x64",
    steps: passed([
      ...setup,
      "download_artifacts",
      "package_tests",
      "editor_tests",
    ]),
    hostResults: hosts,
  });
  assert.match(
    markdown,
    /^## Installed package acceptance passed on macOS amd64/,
  );
  assert.match(markdown, /Linux editor dependencies \| Not applicable/);
  assert.match(markdown, /Alpine packaged CLI tests \| Not applicable/);
});

test("artifact links require successful uploads and the same repository and run", () => {
  const ids = [
    ...setup,
    "build_package",
    "source_rebuild",
    "vulnerability_upload",
    "release_upload",
  ];
  const url =
    "https://github.com/saltyorg/saltbox-lint/actions/runs/123/artifacts/456";
  const steps = {
    ...passed(ids),
    release_upload: { outcome: "success", outputs: { "artifact-url": url } },
  };
  assert.ok(
    renderSummary("check", { ...base, steps }).includes(
      `[Download packages](${url})`,
    ),
  );
  for (const candidate of [
    "https://evil.example/saltyorg/saltbox-lint/actions/runs/123/artifacts/456",
    "https://github.com/saltyorg/other/actions/runs/123/artifacts/456",
    url.replace("123", "124"),
    `${url}?token=secret`,
    "javascript:alert(1)",
  ]) {
    const markdown = renderSummary("check", {
      ...base,
      steps: {
        ...steps,
        release_upload: {
          outcome: "success",
          outputs: { "artifact-url": candidate },
        },
      },
    });
    assert.doesNotMatch(markdown, /\[Download packages\]/);
    assert.doesNotMatch(markdown, /token=secret|evil.example|javascript:/);
  }
  assert.doesNotMatch(
    renderSummary("check", {
      ...base,
      steps: {
        ...steps,
        release_upload: {
          outcome: "failure",
          outputs: { "artifact-url": url },
        },
      },
    }),
    /\[Download packages\]/,
  );
});

test("package counts require verified metadata for this commit and never claim native qualification", () => {
  const steps = passed([
    ...setup,
    "build_package",
    "source_rebuild",
    "vulnerability_upload",
    "release_upload",
  ]);
  const metadata = {
    commit,
    packages: Object.keys(targets).map((target) => ({
      target,
      filename: `saltbox-lint-${target}.vsix`,
      sha256: "a".repeat(64),
    })),
  };
  const markdown = renderSummary("check", {
    ...base,
    steps,
    packageMetadata: metadata,
  });
  assert.match(
    markdown,
    /Verified 6 CLI archives and 8 platform VSIX packages/,
  );
  assert.match(
    markdown,
    /Native and installed editor qualification is reported by their own jobs/,
  );
  for (const invalid of [
    undefined,
    { ...metadata, commit: "f".repeat(40) },
    { ...metadata, packages: metadata.packages.slice(1) },
    {
      ...metadata,
      packages: [metadata.packages[0], ...metadata.packages.slice(0, -1)],
    },
  ])
    assert.doesNotMatch(
      renderSummary("check", { ...base, steps, packageMetadata: invalid }),
      /Verified 6 CLI/,
    );
  assert.doesNotMatch(
    renderSummary("check", {
      ...base,
      steps: { ...steps, build_package: { outcome: "failure" } },
      packageMetadata: metadata,
    }),
    /Verified 6 CLI/,
  );
});

test("untrusted targets, failure text and malformed context cannot inject Markdown", () => {
  const malicious = "[click](javascript:bad)|\n<script>evil</script>`";
  const markdown = renderSummary("acceptance", {
    ...base,
    target: malicious,
    steps: malicious,
    hostUnavailable: malicious,
  });
  assert.match(markdown, /on unknown target/);
  assert.doesNotMatch(markdown, /<script>|\[click\]|javascript:bad\)\|\n/);
  assert.match(markdown, /&#91;click&#93;/);
  assert.match(markdown, /&lt;script&gt;/);
  assert.match(markdown, /&#124;/);
});

test("CLI writes a bounded summary using real owned checkpoint and destination files", (t) => {
  const owned = directory(t);
  const checkpoint = join(owned, "hosts.json");
  const destination = join(owned, "summary.md");
  writeFileSync(checkpoint, JSON.stringify(completedHosts()));
  writeFileSync(destination, "Existing step content\n");
  const run = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../tools/ci-summary.mjs", import.meta.url)),
      "acceptance",
    ],
    {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        GITHUB_SHA: commit,
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_REPOSITORY: base.repository,
        GITHUB_SERVER_URL: base.serverUrl,
        GITHUB_STEP_SUMMARY: destination,
        CI_SUMMARY_TARGET: "linux-x64",
        CI_SUMMARY_JOB_STATUS: "success",
        CI_SUMMARY_STEPS: JSON.stringify(passed(acceptance)),
        CI_SUMMARY_HOST_RESULTS: checkpoint,
      },
    },
  );
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  const markdown = readFileSync(destination, "utf8");
  assert.match(
    markdown,
    /^Existing step content\n## Installed package acceptance passed/,
  );
  assert.ok(Buffer.byteLength(markdown) < 16 * 1024);
});

test("oversized, directory and malformed checkpoint inputs produce unavailable evidence", (t) => {
  const owned = directory(t);
  const destination = join(owned, "summary.md");
  const large = join(owned, "large.json");
  writeFileSync(large, " ".repeat(256 * 1024 + 1));
  const malformed = join(owned, "malformed.json");
  writeFileSync(malformed, "{bad json");
  const dir = join(owned, "directory");
  mkdirSync(dir);
  for (const checkpoint of [large, malformed, dir]) {
    assert.throws(
      () =>
        writeSummary("acceptance", {
          GITHUB_SHA: commit,
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_REPOSITORY: base.repository,
          GITHUB_SERVER_URL: base.serverUrl,
          GITHUB_STEP_SUMMARY: destination,
          CI_SUMMARY_TARGET: "linux-x64",
          CI_SUMMARY_STEPS: JSON.stringify(passed(acceptance)),
          CI_SUMMARY_HOST_RESULTS: checkpoint,
        }),
      /without valid completed profile evidence/,
    );
    const markdown = readFileSync(destination, "utf8");
    assert.match(markdown, /Profile evidence unavailable/);
    assert.doesNotMatch(markdown, /^## Installed package acceptance passed/);
  }
});

test("invalid context writes unavailable results before failing without printing the payload", (t) => {
  const destination = join(directory(t), "summary.md");
  for (const context of [
    undefined,
    "{secret context",
    "[]",
    "x".repeat(256 * 1024 + 1),
  ]) {
    assert.throws(
      () =>
        writeSummary("required", {
          GITHUB_STEP_SUMMARY: destination,
          CI_SUMMARY_NEEDS: context,
        }),
      /CI summary context/,
    );
    const markdown = readFileSync(destination, "utf8");
    assert.match(markdown, /^## CI incomplete/);
    assert.match(markdown, /Native source checks \| Unavailable/);
    assert.doesNotMatch(markdown, /secret context/);
  }
});

test("summary destination errors remain visible failures", (t) => {
  const owned = directory(t);
  assert.throws(
    () => writeSummary("required", { GITHUB_STEP_SUMMARY: owned }),
    /EISDIR|EPERM|EACCES/,
  );
});
