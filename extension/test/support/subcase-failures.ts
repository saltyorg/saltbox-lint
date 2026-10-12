/** Retain each named scenario's original body and cleanup failure graph. */
export class SubcaseFailures {
  private readonly failures: Error[] = [];

  get hasFailures(): boolean {
    return this.failures.length > 0;
  }

  record(name: string, error: unknown): void {
    this.failures.push(
      new Error(`Host subcase failed: ${name}`, { cause: error }),
    );
  }

  throwIfAny(message: string): void {
    if (this.failures.length)
      throw new AggregateError([...this.failures], message, {
        cause: this.failures[0],
      });
  }
}
