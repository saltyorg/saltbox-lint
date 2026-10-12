import { createConnection, type Socket } from "node:net";

export interface FixtureLifetime {
  pid: number;
  port: number;
  token: string;
}
export type LifetimeState =
  "alive" | "endpoint-absent" | "mismatch" | "unavailable";
export interface LifetimeResult {
  state: LifetimeState;
  error?: string;
}

export interface LifetimeProbeAdapters {
  connect?: (port: number) => Socket;
}

/** Credential classification settles only after the exact client socket closes. */
export function probeFixtureLifetime(
  instance: FixtureLifetime,
  request?: string,
  adapters: LifetimeProbeAdapters = {},
): Promise<LifetimeResult> {
  return new Promise((resolve) => {
    const socket =
      adapters.connect?.(instance.port) ??
      createConnection({ host: "127.0.0.1", port: instance.port });
    let response = "";
    let outcome: LifetimeResult | undefined;
    const finish = (state: LifetimeState, error?: string) => {
      if (outcome) return;
      outcome = { state, ...(error ? { error } : {}) };
      clearTimeout(timer);
      socket.destroy();
    };
    const timer = setTimeout(
      () => finish("unavailable", "Owned builder probe timed out"),
      1000,
    );
    socket.once("close", () => {
      if (!outcome) finish("unavailable", "probe closed unexpectedly");
      resolve(outcome!);
    });
    if (request) socket.once("connect", () => socket.end(request));
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("ascii");
      if (response.length > 65) finish("unavailable", "response exceeds bound");
    });
    socket.once("end", () => {
      if (!/^[a-f0-9]{64}\n$/.test(response))
        finish("unavailable", "invalid response");
      else finish(response === instance.token + "\n" ? "alive" : "mismatch");
    });
    socket.once("error", (error) => {
      const code = "code" in error ? error.code : undefined;
      if (code === "ECONNREFUSED") finish("endpoint-absent");
      else finish("unavailable", typeof code === "string" ? code : error.name);
    });
  });
}
