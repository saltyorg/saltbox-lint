// @ts-check
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { runGoToolCLI } from "../../../tools/install-go-tool.mjs";

const state = process.env.SALTBOX_TOOL_FIXTURE_STATE;
const output = process.env.GOBIN;
if (!state || !output)
  throw new Error("The tool fixture requires its owned inputs");
const token = randomBytes(16).toString("hex");
const liveFile = state + ".live.json";

if (process.argv[2] === "--cli-driver") {
  const cancellation = new AbortController();
  const terminate = () => cancellation.abort(new Error("Fixture terminated"));
  process.on("SIGTERM", terminate);
  try {
    const result = await runGoToolCLI(
      "example.test/pinned-tool@v1.2.3",
      { env: process.env, signal: cancellation.signal, timeoutMs: 5000 },
      {
        runInstall: (args, options) =>
          import("../../scripts/owned-command.mjs").then(({ ownedCommand }) =>
            ownedCommand(
              process.execPath,
              [fileURLToPath(import.meta.url), ...args],
              options,
            ),
          ),
      },
    );
    writeFileSync(
      state + ".result",
      JSON.stringify({
        code: result.code,
        evidenceDirectory:
          "evidenceDirectory" in result ? result.evidenceDirectory : null,
      }),
    );
    process.exitCode = result.code;
  } finally {
    process.removeListener("SIGTERM", terminate);
  }
} else if (process.argv[2] === "--pipe-holder") {
  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.once("data", () => socket.end(token + "\n"));
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address");
    writeFileSync(liveFile, JSON.stringify({ port: address.port, token }));
    process.send?.({ ready: true });
  });
} else {
  const target = process.argv[3];
  if (!target) throw new Error("Missing fixture install target");
  /** @type {{target: string, args: string[], gobin: string, attempt: number, priorAbsent: boolean | null}[]} */
  const previous = existsSync(state)
    ? readFileSync(state, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  const attempt =
    previous.filter((record) => record.target === target).length + 1;
  /** @type {unknown} */
  const configured = JSON.parse(
    process.env.SALTBOX_TOOL_FIXTURE_PLAN ?? '["transient","success"]',
  );
  if (
    !Array.isArray(configured) ||
    !configured.length ||
    !configured.every((value) => typeof value === "string")
  )
    throw new Error("Invalid fixture plan");
  const mode =
    process.env.SALTBOX_TOOL_FIXTURE_MODE === "output"
      ? "success"
      : configured[Math.min(attempt - 1, configured.length - 1)];
  let priorAbsent = null;
  if (attempt > 1 && existsSync(liveFile)) {
    /** @type {{port: number, token: string}} */
    const instance = JSON.parse(readFileSync(liveFile, "utf8"));
    priorAbsent = await new Promise((resolve, reject) => {
      const socket = createConnection({
        host: "127.0.0.1",
        port: instance.port,
      });
      let refused = false;
      /** @type {unknown} */
      let failure;
      socket.setTimeout(1000, () =>
        socket.destroy(new Error("Prior owner probe timed out")),
      );
      socket.once("connect", () => socket.end("probe\n"));
      socket.once("data", () =>
        socket.destroy(new Error("Previous attempt still owns its endpoint")),
      );
      socket.once("error", (error) => {
        if ("code" in error && error.code === "ECONNREFUSED") refused = true;
        else failure = error;
      });
      socket.once("close", () => {
        if (failure) reject(failure);
        else if (refused) resolve(true);
        else reject(new Error("Unconfirmed prior ownership"));
      });
    });
  }
  appendFileSync(
    state,
    JSON.stringify({
      target,
      attempt,
      args: process.argv.slice(2),
      gobin: output,
      priorAbsent,
    }) + "\n",
  );
  if (mode === "hold") {
    const server = createServer((socket) => socket.end());
    server.listen(0, "127.0.0.1", () =>
      writeFileSync(state + ".ready", "ready\n"),
    );
  } else if (["success", "large-stdout", "large-stderr"].includes(mode)) {
    mkdirSync(output, { recursive: true });
    const packagePath = target.split("@")[0];
    const name = /^v\d+$/.test(basename(packagePath))
      ? basename(dirname(packagePath))
      : basename(packagePath);
    writeFileSync(join(output, name), "installed fixture\n");
    process.stdout.write(
      mode === "large-stdout"
        ? "x".repeat(2 * 1024 * 1024)
        : `tool stdout ${attempt}\n`,
    );
    process.stderr.write(
      mode === "large-stderr"
        ? "x".repeat(2 * 1024 * 1024)
        : `tool stderr ${attempt}\n`,
    );
  } else {
    if (mode === "retained-pipe") {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), "--pipe-holder"],
        { stdio: ["ignore", "inherit", "inherit", "ipc"] },
      );
      await new Promise((resolve, reject) => {
        child.once("message", resolve);
        child.once("error", reject);
        child.once("exit", () =>
          reject(new Error("Pipe holder exited before readiness")),
        );
      });
      child.disconnect();
      child.unref();
    }
    if (
      ["transient", "retained-pipe", "mixed", "mixed-stdout"].includes(mode)
    ) {
      process.stderr.write("go: downloading github.com/gogo/protobuf v1.3.2\n");
      process.stderr.write(
        'module/importer.go:9:2: github.com/gogo/protobuf@v1.3.2: read "https://proxy.golang.org/github.com/gogo/protobuf/@v/v1.3.2.zip": stream error: stream ID 1025; INTERNAL_ERROR; received from peer\n',
      );
    }
    if (mode === "compile" || mode === "mixed")
      process.stderr.write(
        "# example.test/pinned-tool\n./main.go:4:5: undefined: missingSymbol\n",
      );
    if (mode === "mixed-stdout")
      process.stdout.write("# example.test/tool\nunknown compiler output\n");
    if (mode === "checksum")
      process.stderr.write(
        "go: verifying module: checksum mismatch\nSECURITY ERROR\n",
      );
    if (mode === "auth")
      process.stderr.write(
        "go: example.test/private@v1.2.3: reading https://proxy.example.test/example.test/private/@v/v1.2.3.zip: 401 Unauthorized\n",
      );
    if (mode === "not-found")
      process.stderr.write(
        "go: example.test/missing@v1.2.3: reading https://proxy.golang.org/example.test/missing/@v/v1.2.3.zip: 404 Not Found\n",
      );
    process.exitCode = 1;
  }
}
