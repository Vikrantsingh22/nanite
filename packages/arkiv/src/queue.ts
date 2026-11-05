/**
 * Single-flight FIFO queue: tasks run one at a time, in submission order. One instance per writer
 * account, because entity keys derive from the sender's nonce and concurrent batches would race it.
 * A failing task rejects only its own promise; the queue keeps going.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  get size(): number {
    return this.pending;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.pending--;
    });
  }
}
