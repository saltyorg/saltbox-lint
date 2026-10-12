import { randomBytes } from "node:crypto";
import { Socket } from "node:net";

export const processSupervisorEnvironment = "SALTBOX_LINT_EDITOR_SUPERVISOR";
const maximumLineBytes = 2048;
const ownershipTimeoutMs = 5000;

interface Supervisor {
  address: string;
  token: string;
}
export interface ProcessReservation {
  readonly environment: string;
  readonly signal: AbortSignal;
  cancelNoChild(): Promise<void>;
  completeJoinedChild(pid: number): Promise<void>;
}
export interface ReservationOptions {
  handshakeTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

function configuration(value: string): Supervisor {
  if (value.length > maximumLineBytes)
    throw new Error("Invalid process supervisor configuration");
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("Invalid process supervisor configuration");
  }
  if (
    value.length > maximumLineBytes ||
    !decoded ||
    typeof decoded !== "object" ||
    Array.isArray(decoded)
  )
    throw new Error("Invalid process supervisor configuration");
  const source = decoded as Record<string, unknown>;
  if (
    Object.keys(source).sort().join(",") !== "address,token" ||
    typeof source.address !== "string" ||
    typeof source.token !== "string"
  )
    throw new Error("Invalid process supervisor configuration");
  const address = /^127\.0\.0\.1:([1-9][0-9]*)$/.exec(source.address);
  if (
    !address ||
    Number(address[1]) > 65535 ||
    !/^[0-9a-f]{64}$/.test(source.token)
  )
    throw new Error("Invalid process supervisor configuration");
  return { address: source.address, token: source.token };
}

/** Reserve before spawn; every exit path joins the admitted ownership socket. */
export async function reserveProcess(
  value: string,
  workSignal: AbortSignal,
  options: ReservationOptions = {},
): Promise<ProcessReservation> {
  if (workSignal.aborted) throw new Error("Canceled");
  const supervisor = configuration(value);
  const nonce = randomBytes(32).toString("hex");
  const client = new ReservationClient(supervisor, nonce, options);
  try {
    await client.reserve();
  } catch (error) {
    await client.joinSocket();
    if (workSignal.aborted)
      throw new AggregateError(
        [new Error("Canceled"), error],
        "Reservation cancellation and ownership failed",
      );
    throw error;
  }
  if (workSignal.aborted) {
    const canceled = new Error("Canceled");
    try {
      await client.cancelNoChild();
    } catch (cleanup) {
      throw new AggregateError(
        [canceled, cleanup],
        "Reservation cancellation and cleanup failed",
        { cause: canceled },
      );
    }
    throw canceled;
  }
  return client;
}

class ReservationClient implements ProcessReservation {
  readonly environment: string;
  private readonly lost = new AbortController();
  private readonly socket = new Socket();
  private readonly closed: Promise<void>;
  private readonly writes = new Set<Promise<void>>();
  private readonly supervisor: Supervisor;
  private readonly nonce: string;
  private readonly options: ReservationOptions;
  private expected:
    | {
        key: "reserved" | "completed";
        resolve(): void;
        reject(error: unknown): void;
      }
    | undefined;
  private buffer = "";
  private failure: Error | undefined;
  private completed = false;
  private completion:
    | { kind: "cancel" | "joined"; pid?: number; promise: Promise<void> }
    | undefined;

  constructor(
    supervisor: Supervisor,
    nonce: string,
    options: ReservationOptions,
  ) {
    this.supervisor = supervisor;
    this.nonce = nonce;
    this.options = { ...options };
    this.environment = JSON.stringify({ ...supervisor, nonce });
    this.closed = new Promise((resolve) => {
      this.socket.once("close", () => {
        if (!this.completed)
          this.fail(
            new Error(
              "Process reservation connection closed before completion",
            ),
          );
        resolve();
      });
    });
    this.socket.setNoDelay(true).setEncoding("utf8");
    this.socket.on("error", () =>
      this.fail(new Error("Process reservation connection failed")),
    );
    this.socket.on("data", (data: string) => this.receive(data));
  }

  get signal(): AbortSignal {
    return this.lost.signal;
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.expected?.reject(this.failure);
    this.lost.abort(this.failure);
    this.socket.destroy();
  }

  private receive(data: string): void {
    if (!this.expected) {
      this.fail(new Error("Unexpected process reservation acknowledgement"));
      return;
    }
    this.buffer += data;
    if (Buffer.byteLength(this.buffer) > maximumLineBytes) {
      this.fail(
        new Error("Process reservation acknowledgement exceeded its bound"),
      );
      return;
    }
    const newline = this.buffer.indexOf("\n");
    if (newline < 0) return;
    const line = this.buffer.slice(0, newline);
    this.buffer = this.buffer.slice(newline + 1);
    try {
      const value: unknown = JSON.parse(line);
      const expected = this.expected;
      if (
        this.buffer !== "" ||
        !expected ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        Reflect.get(value, expected.key) !== true
      )
        throw new Error("Invalid process reservation acknowledgement");
      this.expected = undefined;
      if (expected.key === "completed") this.completed = true;
      expected.resolve();
    } catch {
      this.fail(new Error("Invalid process reservation acknowledgement"));
    }
  }

  private write(value: object): Promise<void> {
    const written = new Promise<void>((resolve, reject) => {
      this.socket.write(JSON.stringify(value) + "\n", (error) => {
        if (error) reject(new Error("Process reservation write failed"));
        else resolve();
      });
    });
    const settled = written.then(
      () => {
        this.writes.delete(settled);
      },
      () => {
        this.writes.delete(settled);
      },
    );
    this.writes.add(settled);
    return written;
  }

  private async exchange(
    key: "reserved" | "completed",
    message: object,
  ): Promise<void> {
    if (this.failure) throw this.failure;
    const reply = new Promise<void>((resolve, reject) => {
      this.expected = { key, resolve, reject };
    });
    try {
      await Promise.all([this.write(message), reply]);
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new Error("Process reservation exchange failed"),
      );
      throw error;
    }
  }

  async reserve(): Promise<void> {
    const deadline = setTimeout(
      () => this.fail(new Error("Process reservation admission timed out")),
      this.options.handshakeTimeoutMs ?? ownershipTimeoutMs,
    );
    try {
      const port = Number(this.supervisor.address.slice("127.0.0.1:".length));
      this.socket.connect({ host: "127.0.0.1", port });
      await this.exchange("reserved", {
        token: this.supervisor.token,
        type: "reserve",
        nonce: this.nonce,
      });
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new Error("Process reservation admission failed"),
      );
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  }

  cancelNoChild(): Promise<void> {
    return this.finish("cancel");
  }

  completeJoinedChild(pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 1)
      return Promise.reject(
        new Error("Joined process requires its actual native PID"),
      );
    return this.finish("joined", pid);
  }

  private finish(kind: "cancel" | "joined", pid?: number): Promise<void> {
    if (this.completion) {
      if (this.completion.kind !== kind || this.completion.pid !== pid)
        return Promise.reject(
          new Error("Process reservation completion cannot change"),
        );
      return this.completion.promise;
    }
    const promise = this.complete(kind, pid);
    this.completion = { kind, pid, promise };
    return promise;
  }

  private async complete(
    kind: "cancel" | "joined",
    pid?: number,
  ): Promise<void> {
    // Operation cancellation never aborts this independent completion scope.
    const deadline = setTimeout(
      () => this.fail(new Error("Process reservation cleanup timed out")),
      this.options.cleanupTimeoutMs ?? ownershipTimeoutMs,
    );
    try {
      await this.exchange(
        "completed",
        kind === "cancel" ? { cancel: true } : { joined: true, pid },
      );
      this.socket.end();
      await this.closed;
      if (this.failure) throw this.failure;
    } catch (error) {
      this.socket.destroy();
      await this.joinSocket();
      throw error;
    } finally {
      clearTimeout(deadline);
      await this.joinSocket();
    }
  }

  async joinSocket(): Promise<void> {
    await this.closed;
    await Promise.all([...this.writes]);
  }
}
