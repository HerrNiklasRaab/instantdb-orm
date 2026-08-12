export interface SubscriptionFault {
  label: string;
  message: string;
  status?: number;
  traceId?: string;
}

export interface SubscriptionOutage extends SubscriptionFault {
  attempt: number;
  retryInMs: number;
}

export interface SubscriptionRecovery {
  label: string;
  attempts: number;
  downForMs: number;
}

export interface SubscriptionHandlerFailure {
  label: string;
  error: unknown;
}

/**
 * Where a subscription's health goes. Kept as a port so this package stays
 * ignorant of loggers and analytics — the backend supplies one that reports
 * somewhere a human will actually be told.
 */
export interface SubscriptionObserver {
  /** First payload ever: the subscription is live. Lets a reader distinguish
   * "healthy" from "never registered", which a failure-only feed cannot. */
  connected(event: { label: string }): void;
  /** The transport hiccuped but is retrying itself. Informational. */
  degraded(fault: SubscriptionFault): void;
  /** The transport is gone and will not come back on its own; we will re-open. */
  outage(outage: SubscriptionOutage): void;
  /** A re-opened subscription delivered data again. */
  recovered(recovery: SubscriptionRecovery): void;
  /** The subscription is fine; the handler reading it threw. */
  handlerFailed(failure: SubscriptionHandlerFailure): void;
}

/** The default: what this package did before anyone was listening. */
export class ConsoleSubscriptionObserver implements SubscriptionObserver {
  connected(): void {
    // Success was never worth a line here, and seven of them at boot least of all.
  }

  degraded(fault: SubscriptionFault): void {
    console.warn(`[${fault.label}] subscription degraded:`, fault.message);
  }

  outage(outage: SubscriptionOutage): void {
    console.error(
      `[${outage.label}] subscription closed (status ${outage.status ?? "unknown"}), ` +
        `reconnecting in ${outage.retryInMs}ms (attempt ${outage.attempt}):`,
      outage.message,
    );
  }

  recovered(recovery: SubscriptionRecovery): void {
    console.info(
      `[${recovery.label}] subscription recovered after ${recovery.downForMs}ms ` +
        `and ${recovery.attempts} attempt(s)`,
    );
  }

  handlerFailed(failure: SubscriptionHandlerFailure): void {
    console.error(`[${failure.label}] subscription handler failed:`, failure.error);
  }
}
