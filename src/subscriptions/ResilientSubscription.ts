import type { SubscriptionError, Unsubscribe } from "../subscriptions";
import type { SubscriptionObserver } from "./SubscriptionObserver";
import { SubscriptionRetryPolicy } from "./SubscriptionRetryPolicy";

export interface ResilientSubscriptionDeps<T> {
  label: string;
  subscribe: (onPayload: (payload: T) => void) => Unsubscribe;
  readError: (payload: T) => SubscriptionError | undefined;
  observer: SubscriptionObserver;
  policy?: SubscriptionRetryPolicy;
}

/**
 * Keeps one live query alive across transport death.
 *
 * A transport fails two ways. A transient failure means the transport is
 * already retrying underneath, and re-opening on top of it would only race
 * it. A terminal one means no further payload will ever arrive. Only
 * `isClosed` separates the two, and only the caller can re-open past the
 * second one.
 *
 * A failure before the first payload is left terminal on purpose: it means the
 * query or the credentials are wrong, not that the network blinked, and callers
 * rely on it to fail fast at boot.
 *
 * The transport is injected rather than a client, so the recovery logic is
 * testable with a stub and no database.
 */
export class ResilientSubscription<T> {
  private readonly policy: SubscriptionRetryPolicy;
  private unsubscribe: Unsubscribe | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onPayload: ((payload: T) => void) | null = null;
  private closed = false;
  private everConnected = false;
  private downSince: number | null = null;

  constructor(private readonly deps: ResilientSubscriptionDeps<T>) {
    this.policy = deps.policy ?? new SubscriptionRetryPolicy();
  }

  run(onPayload: (payload: T) => void): { close(): void } {
    this.onPayload = onPayload;
    this.open();
    return { close: () => { this.close(); } };
  }

  private open(): void {
    if (this.closed) return;
    try {
      this.unsubscribe = this.deps.subscribe((payload) => { this.handle(payload); });
    } catch (err) {
      // Subscribing can throw outright (a refused socket, a dead fetch stack).
      // That is one more outage, not a reason to stop trying forever.
      this.scheduleReopen({ message: err instanceof Error ? err.message : String(err) });
    }
  }

  private handle(payload: T): void {
    if (this.closed) return;
    const error = this.deps.readError(payload);
    if (error === undefined) {
      this.markConnected();
      this.onPayload?.(payload);
      return;
    }
    if (error.isClosed !== true) {
      this.deps.observer.degraded(this.fault(error));
      this.onPayload?.(payload);
      return;
    }
    if (!this.everConnected) {
      this.onPayload?.(payload);
      return;
    }
    this.scheduleReopen(error);
  }

  private markConnected(): void {
    const now = Date.now();
    this.policy.recordConnected(now);
    if (!this.everConnected) {
      this.everConnected = true;
      this.deps.observer.connected({ label: this.deps.label });
    }
    if (this.downSince === null) return;
    this.deps.observer.recovered({
      label: this.deps.label,
      attempts: this.policy.attemptCount,
      downForMs: now - this.downSince,
    });
    this.downSince = null;
  }

  private scheduleReopen(error: SubscriptionError): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const now = Date.now();
    this.downSince ??= now;
    const retryInMs = this.policy.nextDelay(now);
    this.deps.observer.outage({
      ...this.fault(error),
      attempt: this.policy.attemptCount,
      retryInMs,
    });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, retryInMs);
  }

  private fault(error: SubscriptionError): {
    label: string;
    message: string;
    status?: number;
    traceId?: string;
  } {
    return {
      label: this.deps.label,
      message: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
    };
  }

  private close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.onPayload = null;
  }
}
