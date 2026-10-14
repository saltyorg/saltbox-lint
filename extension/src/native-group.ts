import { execFile as nativeExecFile } from "node:child_process";

// Node's actual execFile error has signal:null for an ordinary nonzero exit.
export type QueryError = Omit<
  import("node:child_process").ExecFileException,
  "signal"
> & {
  signal?: NodeJS.Signals | null;
};
export interface GroupQueryDependencies {
  platform?: NodeJS.Platform;
  execFile?: (
    file: string,
    args: readonly string[],
    options: import("node:child_process").ExecFileOptionsWithStringEncoding,
    callback: (
      error: QueryError | null,
      stdout: string,
      stderr: string,
    ) => void,
  ) => import("node:child_process").ChildProcess;
}
export interface GroupQueryObservation {
  platform: NodeJS.Platform;
  group: number;
  elapsedMs: number;
  timeoutMs: number;
  maxBufferBytes: number;
  code: string | number | null;
  killed: boolean | null;
  signal: string | null;
  aborted: boolean;
  closeCode: number | null;
  closeSignal: NodeJS.Signals | null;
  stdoutBytes: number;
  stderrBytes: number;
}

/** False proves no live members; true also covers incomplete Linux observations. */
export function liveGroupMembers(
  snapshot: string,
  group: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!Number.isSafeInteger(group) || group <= 1)
    throw new Error("Invalid owned process group");
  if (!["linux", "darwin"].includes(platform))
    throw new Error("Owned process group observation requires Linux or Darwin");
  let live = false;
  let rows = 0;
  const members = new Map<number, { count: number; threads: Set<number> }>();
  const seenMembers = new Set();
  for (const line of snapshot.split("\n")) {
    if (!line.trim()) continue;
    const match = (
      platform === "linux"
        ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([DRSTtWXZI])\s*$/
        : /^\s*(\d+)\s+(\d+)\s+((?:[H?IRSTU](?:<|N)?X?E?V?L?s?\+?|Z(?:<|N)?X?V?L?s?\+?))\s*$/
    ).exec(line);
    if (!match)
      throw new Error(
        `Unrecognized process group snapshot (${platform}, owned group ${group}): ${JSON.stringify(line.slice(0, 256))}`,
      );
    const numbers = match.slice(1, platform === "linux" ? 5 : 3).map(Number);
    if (
      numbers.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      numbers.slice(1).some((value) => value === 0)
    )
      throw new Error("Unrecognized process group snapshot identity");
    rows++;
    if (numbers[0] !== group) continue;
    const pid = numbers[1];
    if (platform === "linux") {
      const [, , tid, count] = numbers;
      let member = members.get(pid);
      if (!member) {
        member = { count, threads: new Set() };
        members.set(pid, member);
      }
      if (member.threads.has(tid))
        throw new Error("Inconsistent process group thread snapshot");
      // ps enumerates tasks and reads each stat separately while threads exit.
      if (member.count !== count) live = true;
      member.threads.add(tid);
      if (match[5] !== "Z") live = true;
    } else {
      if (seenMembers.has(pid))
        throw new Error("Duplicate process group member");
      seenMembers.add(pid);
      if (!match[3].startsWith("Z")) live = true;
    }
  }
  if (!rows) throw new Error("Empty process group snapshot");
  if (!snapshot.endsWith("\n"))
    throw new Error("Unterminated process group snapshot");
  if (platform === "linux") {
    for (const [pid, member] of members) {
      if (member.threads.size !== member.count || !member.threads.has(pid))
        live = true;
    }
  }
  return live;
}

export async function groupHasLiveMembers(
  group: number,
  signal?: AbortSignal,
  dependencies: GroupQueryDependencies = {},
): Promise<boolean> {
  if (!Number.isSafeInteger(group) || group <= 1)
    throw new Error("Invalid owned process group");
  const platform = dependencies.platform ?? process.platform;
  if (!["linux", "darwin"].includes(platform))
    throw new Error("Owned process group observation requires Linux or Darwin");
  const execFile = dependencies.execFile ?? nativeExecFile;
  const started = performance.now();
  const timeoutMs = 1000;
  const maxBufferBytes = 4 * 1024 * 1024;
  let result:
    { error: QueryError | null; stdout: string; stderr: string } | undefined;
  let closeCode: number | null = null;
  let closeSignal: NodeJS.Signals | null = null;
  const observationError = (cause: Error) => {
    const native = result?.error;
    const observation: GroupQueryObservation = {
      platform,
      group,
      elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
      timeoutMs,
      maxBufferBytes,
      code:
        typeof native?.code === "string"
          ? native.code.slice(0, 64)
          : (native?.code ?? null),
      killed: native?.killed ?? null,
      signal: native?.signal?.slice(0, 32) ?? null,
      aborted: signal?.aborted ?? false,
      closeCode,
      closeSignal,
      stdoutBytes: Buffer.byteLength(result?.stdout ?? ""),
      stderrBytes: Buffer.byteLength(result?.stderr ?? ""),
    };
    return Object.assign(
      new Error(
        `Owned process group query failed: ${JSON.stringify(observation)}`,
        { cause },
      ),
      {
        observation,
        ...(native?.code === undefined ? {} : { code: native.code }),
      },
    );
  };
  await new Promise<void>((resolve, reject) => {
    let probe: import("node:child_process").ChildProcess;
    try {
      probe = execFile(
        "/bin/ps",
        platform === "linux"
          ? ["-A", "-L", "-o", "pgid=,pid=,lwp=,nlwp=,s="]
          : ["-g", String(group), "-x", "-o", "pgid=,pid=,state="],
        {
          encoding: "utf8",
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: maxBufferBytes,
          signal,
          env: {
            ...process.env,
            LC_ALL: "C",
            ...(platform === "darwin" ? { COMMAND_MODE: "unix2003" } : {}),
          },
        },
        (error, stdout, stderr) => {
          result ??= { error, stdout, stderr };
        },
      );
    } catch (error) {
      reject(
        observationError(
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
      return;
    }
    // Abort/spawn errors can invoke execFile's callback before the child closes.
    // Always join that exact probe before completing the observation.
    probe.once("close", (code, exitSignal) => {
      closeCode = code;
      closeSignal = exitSignal;
      resolve();
    });
  });
  if (!result)
    throw observationError(new Error("Missing process group snapshot result"));
  // Apple's scoped ps returns 1 with no rows when KERN_PROC_PGRP has no matches.
  // An abort, signal, diagnostic or inconsistent native status cannot prove exit.
  if (
    platform === "darwin" &&
    closeCode === 1 &&
    closeSignal === null &&
    result.error?.code === 1 &&
    result.error.killed === false &&
    result.error.signal === null &&
    !signal?.aborted &&
    result.stdout === "" &&
    result.stderr === ""
  )
    return false;
  if (result.error) throw observationError(result.error);
  if (closeCode !== 0 || closeSignal !== null || signal?.aborted)
    throw observationError(
      new Error("Unqualified native process query status"),
    );
  if (result.stderr !== "")
    throw observationError(new Error("Native process query produced stderr"));
  if (platform === "darwin") {
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;
      if (
        !/^\s*(\d+)\s/.test(line) ||
        Number(/^\s*(\d+)/.exec(line)?.[1]) !== group
      )
        throw observationError(
          new Error("Scoped process query returned a different group"),
        );
    }
  }
  // Linux's leader can be Z while another thread retains open endpoints. Check
  // every advertised thread. Darwin's SZOMB follows final-thread exit and task
  // detachment, so its process state proves the task has no remaining worker.
  // Darwin H and unavailable-task ? states cannot prove exit and remain live.
  try {
    return liveGroupMembers(result.stdout, group, platform);
  } catch (error) {
    throw observationError(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}
