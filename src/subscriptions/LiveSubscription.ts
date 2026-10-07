import type { QueryResult } from "../queries/SyncQuery";
import type { QuerySubscriptionState } from "./Subscription";

/**
 * A query kept answered for as long as someone listens: re-read whenever
 * the data may have changed, and passed on only when the answer did.
 * Refreshes landing while a read is under way collapse into exactly one more.
 */
export class LiveSubscription {
  private active = true;
  private running = false;
  private stale = false;
  private lastDelivered: string | null = null;

  constructor(
    private readonly read: () => Promise<QueryResult>,
    private readonly listener: (state: QuerySubscriptionState) => void,
  ) {}

  refresh(): void {
    void this.readUntilFresh();
  }

  stop(): void {
    this.active = false;
  }

  private async readUntilFresh(): Promise<void> {
    if (this.running) {
      this.stale = true;
      return;
    }
    this.running = true;
    do {
      this.stale = false;
      try {
        const data = await this.read();
        if (this.active) this.deliver(data);
      } catch (error) {
        if (this.active) this.listener({ error: { message: error instanceof Error ? error.message : String(error) }, data: undefined });
      }
    } while (this.anotherReadWanted());
    this.running = false;
  }

  // A method, because `stale` can flip while a read is awaited.
  private anotherReadWanted(): boolean {
    return this.stale && this.active;
  }

  // Many replica changes leave a query's answer as it was; an unchanged
  // answer is not news.
  private deliver(data: QueryResult): void {
    const serialized = JSON.stringify(data);
    if (serialized === this.lastDelivered) return;
    this.lastDelivered = serialized;
    this.listener({ error: undefined, data });
  }
}
