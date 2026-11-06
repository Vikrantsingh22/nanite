/*
 * One process-wide queue for operator-signed ENS work. The operator wallet has a single nonce, and the
 * username-claim runner and the agent job runner each own a chain client, so whole jobs from both
 * must run one after another.
 */
let tail: Promise<unknown> = Promise.resolve();

export function withOperatorLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
