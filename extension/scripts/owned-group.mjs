import { execFile } from "node:child_process";

export function liveGroupMembers(snapshot, group, platform = process.platform) {
  if (!Number.isSafeInteger(group) || group <= 1)
    throw new Error("Invalid owned process group");
  if (!["linux", "darwin"].includes(platform))
    throw new Error("Owned process group observation requires Linux or Darwin");
  let live = false;
  let rows = 0;
  const members = new Map();
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
      if (member.count !== count || member.threads.has(tid))
        throw new Error("Inconsistent process group thread snapshot");
      member.threads.add(tid);
      if (match[5] !== "Z") live = true;
    } else {
      if (members.has(pid)) throw new Error("Duplicate process group member");
      members.set(pid, true);
      if (!match[3].startsWith("Z")) live = true;
    }
  }
  if (!rows) throw new Error("Empty process group snapshot");
  if (!snapshot.endsWith("\n"))
    throw new Error("Unterminated process group snapshot");
  if (platform === "linux") {
    for (const [pid, member] of members) {
      if (member.threads.size !== member.count || !member.threads.has(pid))
        throw new Error("Incomplete process group thread snapshot");
    }
  }
  return live;
}

export async function groupHasLiveMembers(group, signal) {
  if (!["linux", "darwin"].includes(process.platform))
    throw new Error("Owned process group observation requires Linux or Darwin");
  const snapshot = await new Promise((resolve, reject) => {
    let result;
    const probe = execFile(
      "/bin/ps",
      process.platform === "linux"
        ? ["-A", "-L", "-o", "pgid=,pid=,lwp=,nlwp=,s="]
        : ["-A", "-o", "pgid=,pid=,state="],
      {
        timeout: 1000,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        signal,
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout) => {
        result = { error, stdout };
      },
    );
    // Abort/spawn errors can invoke execFile's callback before the child closes.
    // Always join that exact probe before completing the observation.
    probe.once("close", () => {
      if (result?.error) reject(result.error);
      else if (!result)
        reject(new Error("Missing process group snapshot result"));
      else resolve(result.stdout);
    });
  });
  // Linux's leader can be Z while another thread retains open endpoints. Check
  // every advertised thread. Darwin's SZOMB follows final-thread exit and task
  // detachment, so its process state proves the task has no remaining worker.
  // Darwin H and unavailable-task ? states cannot prove exit and remain live.
  return liveGroupMembers(snapshot, group);
}
