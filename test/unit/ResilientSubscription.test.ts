import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SubscriptionError, Unsubscribe } from "../../src/instantdb";
import { ResilientSubscription } from "../../src/subscriptions/ResilientSubscription";
import { SubscriptionRetryPolicy } from "../../src/subscriptions/SubscriptionRetryPolicy";
import type {
  SubscriptionFault,
  SubscriptionHandlerFailure,
  SubscriptionObserver,
  SubscriptionOutage,
  SubscriptionRecovery,
} from "../../src/subscriptions/SubscriptionObserver";

type Payload = { error?: SubscriptionError };

class RecordingObserver implements SubscriptionObserver {
  readonly connects: string[] = [];
  readonly degradations: SubscriptionFault[] = [];
  readonly outages: SubscriptionOutage[] = [];
  readonly recoveries: SubscriptionRecovery[] = [];
  readonly handlerFailures: SubscriptionHandlerFailure[] = [];

  connected(event: { label: string }): void { this.connects.push(event.label); }
  degraded(fault: SubscriptionFault): void { this.degradations.push(fault); }
  outage(outage: SubscriptionOutage): void { this.outages.push(outage); }
  recovered(recovery: SubscriptionRecovery): void { this.recoveries.push(recovery); }
  handlerFailed(failure: SubscriptionHandlerFailure): void { this.handlerFailures.push(failure); }
}

/** Stands in for the SSE transport: counts connections and lets the test push
 * payloads into whichever one is live. */
class StubTransport {
  connections = 0;
  unsubscribes = 0;
  private push: ((payload: Payload) => void) | null = null;
  throwOnNextSubscribe = false;

  readonly subscribe = (onPayload: (payload: Payload) => void): Unsubscribe => {
    if (this.throwOnNextSubscribe) {
      this.throwOnNextSubscribe = false;
      throw new Error("socket refused");
    }
    this.connections += 1;
    this.push = onPayload;
    return () => { this.unsubscribes += 1; };
  };

  emitData(): void { this.push?.({}); }
  emitError(error: SubscriptionError): void { this.push?.({ error }); }
}

const dropped: SubscriptionError = { message: "socket closed unexpectedly", isClosed: false };
const terminal: SubscriptionError = { message: "upstream error", status: 502, isClosed: true };

describe("ResilientSubscription", () => {
  let transport: StubTransport;
  let observer: RecordingObserver;
  let received: Payload[];

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new StubTransport();
    observer = new RecordingObserver();
    received = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function start(): { close(): void } {
    const subscription = new ResilientSubscription<Payload>({
      label: "TestReactor",
      subscribe: transport.subscribe,
      readError: (payload) => payload.error,
      observer,
      // No jitter, so the delays below are the policy's raw curve.
      policy: new SubscriptionRetryPolicy(() => 1),
    });
    return subscription.run((payload) => { received.push(payload); });
  }

  it("re-opens the transport after a terminal error", () => {
    start();
    transport.emitData();

    transport.emitError(terminal);

    expect(transport.unsubscribes).toBe(1);
    expect(transport.connections).toBe(1);
    vi.advanceTimersByTime(0);
    expect(transport.connections).toBe(2);
  });

  it("leaves a transient error to the transport's own retry", () => {
    start();
    transport.emitData();

    transport.emitError(dropped);

    vi.advanceTimersByTime(60_000);
    expect(transport.connections).toBe(1);
    expect(transport.unsubscribes).toBe(0);
    expect(observer.degradations).toHaveLength(1);
    expect(observer.outages).toHaveLength(0);
  });

  it("forwards a transient error but never a terminal one it is handling", () => {
    start();
    transport.emitData();

    transport.emitError(dropped);
    transport.emitError(terminal);

    expect(received.filter((p) => p.error !== undefined)).toEqual([{ error: dropped }]);
  });

  it("does not retry a failure that arrives before the first payload", () => {
    start();

    transport.emitError(terminal);

    vi.advanceTimersByTime(60_000);
    expect(transport.connections).toBe(1);
    expect(observer.outages).toHaveLength(0);
    expect(received).toEqual([{ error: terminal }]);
  });

  it("backs off linearly and caps at 15s", () => {
    start();
    transport.emitData();

    const delays: number[] = [];
    for (let attempt = 0; attempt < 35; attempt += 1) {
      transport.emitError(terminal);
      delays.push(observer.outages[observer.outages.length - 1]?.retryInMs ?? -1);
      vi.advanceTimersByTime(15_000);
    }

    expect(delays.slice(0, 4)).toEqual([0, 500, 1000, 1500]);
    expect(delays[delays.length - 1]).toBe(15_000);
    expect(Math.max(...delays)).toBe(15_000);
  });

  it("resets the backoff once a connection has held for 5 minutes", () => {
    start();
    transport.emitData();
    transport.emitError(terminal);
    vi.advanceTimersByTime(0);
    transport.emitError(terminal);
    vi.advanceTimersByTime(500);
    expect(observer.outages[1]?.retryInMs).toBe(500);

    transport.emitData();
    vi.advanceTimersByTime(300_000);
    transport.emitError(terminal);

    expect(observer.outages[2]?.retryInMs).toBe(0);
    expect(observer.outages[2]?.attempt).toBe(1);
  });

  it("reports the recovery once data flows again", () => {
    start();
    transport.emitData();

    transport.emitError(terminal);
    vi.advanceTimersByTime(1_000);
    transport.emitData();

    expect(observer.recoveries).toHaveLength(1);
    expect(observer.recoveries[0]?.label).toBe("TestReactor");
    expect(observer.recoveries[0]?.downForMs).toBe(1_000);
  });

  it("keeps retrying when re-subscribing throws", () => {
    start();
    transport.emitData();

    transport.throwOnNextSubscribe = true;
    transport.emitError(terminal);
    vi.advanceTimersByTime(0);

    expect(observer.outages).toHaveLength(2);
    vi.advanceTimersByTime(500);
    expect(transport.connections).toBe(2);
  });

  it("stops everything on close, and close is idempotent", () => {
    const handle = start();
    transport.emitData();
    transport.emitError(terminal);

    handle.close();
    handle.close();

    vi.advanceTimersByTime(60_000);
    expect(transport.connections).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores payloads that arrive after close", () => {
    const handle = start();
    transport.emitData();
    handle.close();

    transport.emitData();

    expect(received).toHaveLength(1);
  });
});
