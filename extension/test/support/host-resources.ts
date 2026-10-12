import { TestResources } from "./test-resources.ts";

interface JoinedResource {
  dispose(): void;
  join(): PromiseLike<void>;
}

/** Cancel producers before joining admitted work, then join before restoration. */
export function ownJoinedResource<T extends JoinedResource>(
  resources: TestResources,
  name: string,
  resource: T,
): T {
  let canceled = false;
  const failures: unknown[] = [];
  const cancel = () => {
    if (canceled) return;
    canceled = true;
    try {
      resource.dispose();
    } catch (error) {
      failures.push(error);
    }
  };
  resources.defer(name, async () => {
    cancel();
    try {
      await resource.join();
    } catch (error) {
      failures.push(error);
    } finally {
      resources.signal.removeEventListener("abort", cancel);
    }
    if (failures.length)
      throw new AggregateError(failures, `Owned ${name} failed to close`);
  });
  resources.signal.addEventListener("abort", cancel, { once: true });
  if (resources.signal.aborted) cancel();
  return resource;
}
