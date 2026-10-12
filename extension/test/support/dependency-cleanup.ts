export interface DependencyCleanup {
  observers: readonly ({ dispose(): void } | undefined)[];
  owner: { dispose(): void; join?(): Promise<void> };
  admission?: Promise<unknown>;
  afterDisposal: () => Promise<void>;
  subscriptions: readonly { dispose(): void }[];
  releaseAliases: () => Promise<void>;
  restoreEnvironment: () => void;
  releaseFiles: () => Promise<void>;
}

/** Stop producers, join the full editor operation, then remove their inputs. */
export async function cleanupDependencies(
  input: DependencyCleanup,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  const attempt = async (operation: () => unknown) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  for (const observer of input.observers)
    await attempt(() => observer?.dispose());
  await attempt(() => input.owner.dispose());
  await attempt(() => input.afterDisposal());
  await attempt(() => input.admission);
  await attempt(() => input.owner.join?.());
  for (const subscription of input.subscriptions)
    await attempt(() => subscription.dispose());
  await attempt(input.releaseAliases);
  await attempt(input.restoreEnvironment);
  await attempt(input.releaseFiles);
  return failures;
}
