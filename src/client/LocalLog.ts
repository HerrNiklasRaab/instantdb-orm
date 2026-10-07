import type { ZenStackModels } from "../schema/DatabaseClient";
import { Transaction, type TransactionOutcome } from "../transactions";
import { logClientOf, type LogClient } from "../schema/logClient";

/**
 * This client's copy of the transaction log — the server's `transactions`
 * and `changes` tables, in its SQLite. Its own transactions sit here with
 * their changes as `pending` until the server answers; every transaction it
 * is told about is recorded too, which is how it knows where to resume when
 * it reconnects. Only own transactions are ever pending.
 */
export class LocalLog {
  private readonly log: LogClient;
  private lastLoggedAt = 0;

  constructor(client: ZenStackModels) {
    this.log = logClientOf(client);
  }

  async addPending(transaction: Transaction): Promise<void> {
    await this.log.transactions.create({
      data: { id: transaction.id, status: "pending", loggedAt: this.nextLoggedAt() },
    });
    await this.log.changes.createMany({ data: transaction.toLogRows() });
  }

  /** The server's verdict on a transaction, own or someone else's. */
  async record(outcome: TransactionOutcome): Promise<void> {
    const verdict = { status: outcome.status, tick: outcome.tick, reason: outcome.reason };
    await this.log.transactions.upsert({
      where: { id: outcome.transactionId },
      create: { id: outcome.transactionId, ...verdict },
      update: verdict,
    });
  }

  /** The verdict this client has recorded for a transaction; `null` while there is none. */
  async verdictOn(transactionId: string): Promise<TransactionOutcome | null> {
    const entry = await this.log.transactions.findUnique({ where: { id: transactionId } });
    if (!entry || (entry.status !== "committed" && entry.status !== "denied")) return null;
    return { transactionId, status: entry.status, tick: entry.tick, reason: entry.reason };
  }

  async isOwnPending(transactionId: string): Promise<boolean> {
    return this.log.transactions.exists({ where: { id: transactionId, status: "pending" } });
  }

  /** Own transactions the server has not answered yet, oldest first. */
  async pending(): Promise<Transaction[]> {
    const rows = await this.log.transactions.findMany({
      where: { status: "pending" },
      orderBy: { loggedAt: "asc" },
      include: { changes: { orderBy: { position: "asc" } } },
    });
    return rows.map(({ id, changes }) => Transaction.fromLogRows(id, changes));
  }

  // Pending transactions are resent in the order they were made; a clock
  // alone could stamp two of them identically.
  private nextLoggedAt(): Date {
    this.lastLoggedAt = Math.max(this.lastLoggedAt + 1, Date.now());
    return new Date(this.lastLoggedAt);
  }
}
