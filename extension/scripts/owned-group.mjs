import { execFile } from "node:child_process";

export function liveGroupMembers(snapshot, group) {
  if (!Number.isSafeInteger(group) || group <= 1)
    throw new Error("Invalid owned process group");
  let live = false;
  let rows = 0;
  for (const line of snapshot.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+([A-Za-z][^\s]*)\s*$/.exec(line);
    if (!match) throw new Error("Unrecognized process group snapshot");
    rows++;
    if (Number(match[1]) === group && !match[2].startsWith("Z")) live = true;
  }
  if (!rows) throw new Error("Empty process group snapshot");
  return live;
}

export async function groupHasLiveMembers(group, signal) {
  if (!["linux", "darwin"].includes(process.platform))
    throw new Error("Owned process group observation requires Linux or Darwin");
  const snapshot = await new Promise((resolve, reject) => {
    let result;
    const probe = execFile(
      "/bin/ps",
      ["-A", "-o", "pgid=,state="],
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
  // A zombie has no executable work or open endpoint. Its parent's wait policy
  // must not extend this command's cleanup lifetime.
  return liveGroupMembers(snapshot, group);
}
