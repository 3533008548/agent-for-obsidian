/** Keeps repeated clicks from issuing the same external request twice. */
export class InFlightRequestGate {
  private readonly running = new Map<string, Promise<unknown>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const active = this.running.get(key);
    if (active) {
      return active as Promise<T>;
    }

    let shared: Promise<T>;
    shared = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.running.get(key) === shared) {
          this.running.delete(key);
        }
      });
    this.running.set(key, shared);
    return shared;
  }
}
