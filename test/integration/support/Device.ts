import { RootStore } from "../../../src/object-graph/store/RootStore";
import type { TransactionOutcome } from "../../../src/transactions";
import type { Socket } from "../../../src/protocol";
import { SyncClient, type LocalReplica } from "../../../src/client";
import type { SubscriptionFault } from "../../../src/subscriptions";
import { assertDefined, openReplica, openSocket, registerIdentity, type ConnectionOptions, type TestStore } from "./clients";
import { schema, type SchemaType } from "../../support/zenstack/client/schema";

/** Sits between the client and its real socket so the test can cut the line. */
class ControllableSocket implements Socket {
  private readonly messageHandlers: ((frame: string) => void)[] = [];
  private readonly closeHandlers: (() => void)[] = [];
  private loseNext = false;
  private open = true;

  constructor(
    private readonly inner: Socket,
    private readonly received: string[],
  ) {
    inner.onMessage((frame) => {
      if (!this.open) return;
      if (this.loseNext) {
        this.loseNext = false;
        this.close();
        return;
      }
      this.received.push(frame);
      for (const handler of this.messageHandlers) handler(frame);
    });
    inner.onClose(() => { this.close(); });
  }

  /** The next frame from the server never arrives, and the connection drops right after. */
  loseNextServerFrame(): void {
    this.loseNext = true;
  }

  send(frame: string): void {
    if (this.open) this.inner.send(frame);
  }

  onMessage(handler: (frame: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.inner.close();
    for (const handler of this.closeHandlers) handler();
  }
}

/**
 * One device, as the tests see it: a `SyncClient` over one SQLite replica,
 * with a connection that can be cut and restored, and an app that can be
 * "restarted" — a new `SyncClient` on the same replica, nothing kept in memory.
 */
export class Device {
  readonly client: SyncClient<SchemaType>;
  /** Every frame the server has delivered to this device, across connections. */
  readonly receivedFrames: string[] = [];
  private current: ControllableSocket | null = null;

  private constructor(
    private readonly identityId: string | null,
    private readonly replica: LocalReplica,
    private readonly line: { online: boolean },
  ) {
    this.client = new SyncClient(schema, () => this.connect(), replica);
  }

  static async open(email?: string, options: ConnectionOptions = {}): Promise<Device> {
    const identityId = email === undefined ? null : registerIdentity(email);
    return new Device(identityId, await openReplica(options), { online: true });
  }

  store(options: { denials?: TransactionOutcome[]; faults?: SubscriptionFault[] } = {}): TestStore {
    return new RootStore({
      client: this.client,
      onTransactionDenied: (outcome) => { options.denials?.push(outcome); },
      subscriptionObserver: {
        connected: () => undefined,
        degraded: (fault) => { options.faults?.push(fault); },
        outage: () => undefined,
        recovered: () => undefined,
        handlerFailed: () => undefined,
      },
    });
  }

  goOffline(): void {
    this.line.online = false;
    this.current?.close();
  }

  goOnline(): void {
    this.line.online = true;
  }

  loseNextServerFrame(): void {
    assertDefined(this.current, "device has no connection to lose a frame on");
    this.current.loseNextServerFrame();
  }

  /** App restart: the old client is gone for good; same SQLite, same network situation. */
  reopen(): Device {
    this.client.close();
    return new Device(this.identityId, this.replica, this.line);
  }

  /** How many frames arrived since `mark` was taken with `framesReceived()`. */
  framesReceived(): number {
    return this.receivedFrames.length;
  }

  framesSince(mark: number): string[] {
    return this.receivedFrames.slice(mark);
  }

  private connect(): Socket {
    if (!this.line.online) throw new Error("offline");
    this.current = new ControllableSocket(openSocket(this.identityId), this.receivedFrames);
    return this.current;
  }
}
