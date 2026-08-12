const STEP_MS = 500;
const MAX_DELAY_MS = 15_000;
const STABLE_RESET_MS = 300_000;

/**
 * InstantDB's own reconnect cadence, lifted from the supervisor they wrote in
 * their Python SDK (`_async/subscribe.py`): linear 0.5s steps capped at 15s,
 * attempt counter reset once a connection has held for five minutes. The first
 * retry is therefore immediate — a dropped stream is usually just a drop.
 *
 * The jitter is ours, not theirs: seven reactors share one process and one
 * upstream, so an upstream fault takes them out together and an unjittered
 * common backoff would have all seven reconnect in lockstep.
 */
export class SubscriptionRetryPolicy {
  private attempts = 0;
  private connectedAt: number | null = null;

  constructor(private readonly random: () => number = Math.random) {}

  /** A payload arrived: the connection is real. Only the first one per
   * connection counts — stability is measured from when it came up. */
  recordConnected(now: number): void {
    this.connectedAt ??= now;
  }

  nextDelay(now: number): number {
    if (this.hasHeldLongEnough(now)) this.attempts = 0;
    this.connectedAt = null;
    this.attempts += 1;
    const ceiling = Math.min(STEP_MS * (this.attempts - 1), MAX_DELAY_MS);
    return Math.round(ceiling * this.random());
  }

  get attemptCount(): number {
    return this.attempts;
  }

  private hasHeldLongEnough(now: number): boolean {
    return this.connectedAt !== null && now - this.connectedAt >= STABLE_RESET_MS;
  }
}
