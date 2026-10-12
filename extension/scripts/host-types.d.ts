import type { TestOptions } from "@vscode/test-electron";
import type { SpawnOptions } from "node:child_process";
import type { OwnershipRelease } from "./host-process-supervisor.mjs";

export type HostProfile = Readonly<{
  root: string;
  workspaceRoot: string;
  userData: string;
  extensionsDir: string;
  controller: string;
}>;

export type CommandOptions = SpawnOptions & {
  cwd?: string;
  phase: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};
export type HostCommand = (
  command: string,
  args: string[],
  options: CommandOptions,
) => Promise<string>;
export type InstalledProduct = {
  directory: string;
  version: string;
  cliPath: string;
  cliSha256: string;
};
export type ArchiveEntry = { bytes: Buffer; mode?: number };
export type ReadArchive = (
  filename: string,
) => Promise<Map<string, ArchiveEntry>>;
export type HostLaunchOptions = TestOptions & {
  vscodeExecutablePath: string;
  launchArgs: string[];
  extensionTestsEnv: NodeJS.ProcessEnv;
};
export type HostConfiguration = {
  env?: NodeJS.ProcessEnv;
  directory?: string;
  executable?: string;
};
export type ProfileRecord = {
  version: string;
  mode: string;
  phase: string;
  stage: string;
  elapsedMs?: number;
  error?: string;
  profileRoot?: string;
  reason?: string;
  reservations?: number;
  registrations?: number;
  groups?: number;
  released?: boolean;
};
export type PhaseRecorder = <T>(
  phase: string,
  operation: () => T | PromiseLike<T>,
) => Promise<T>;
export type Report = (record: ProfileRecord) => void;
export type HostProfileDependencies = {
  command?: (
    command: string,
    args: string[],
    options: CommandOptions,
  ) => Promise<unknown>;
  createProfile?: (options: { workspaceBase?: string }) => HostProfile;
  cleanupProfile?: (
    profile: HostProfile,
    options: { logsPath?: string; label?: string },
  ) => void | Promise<void>;
  createSupervisor?: () => Promise<
    | {
        environment: string;
        finish: () => Promise<OwnershipRelease | void>;
      }
    | undefined
  >;
  clock?: () => number;
  report?: Report;
};
export type WorkerDependencies = {
  electron?: {
    downloadAndUnzipVSCode?: (version: string) => Promise<string>;
    resolveCliArgsFromVSCodeExecutablePath?: (
      executable: string,
      options: { reuseMachineInstall: boolean },
    ) => string[];
    runTests: (options: TestOptions) => Promise<unknown>;
  };
  command?: HostCommand;
  clock?: () => number;
  report?: Report;
  readArchive?: ReadArchive;
};
