interface DisposableResource {
  dispose(): unknown;
}

function disposalErrors(resources: readonly DisposableResource[]): unknown[] {
  const errors: unknown[] = [];
  for (const resource of resources) {
    try {
      resource.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

/** Attempt every release, even if an earlier resource fails. */
export function disposeResources(
  resources: readonly DisposableResource[],
): void {
  const errors = disposalErrors(resources);
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, "Resource disposal failed");
}

/** Roll back completed acquisitions and retain the original setup error. */
export function rollbackResources(
  primary: unknown,
  resources: readonly DisposableResource[],
): never {
  const errors = disposalErrors([...resources].reverse());
  if (!errors.length) throw primary;
  throw new AggregateError(
    [primary, ...errors],
    "Resource setup and rollback failed",
    { cause: primary },
  );
}

/** Transfer an acquired group to one idempotent owner. */
export function combineDisposables(
  resources: readonly DisposableResource[],
): DisposableResource {
  let owned = [...resources];
  return {
    dispose() {
      const releasing = owned;
      owned = [];
      disposeResources(releasing);
    },
  };
}
