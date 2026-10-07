import { type ChangeLogRow, Transaction, type TransactionOutcome, type TransactionStatus } from "../transactions";

/** A transaction as the server's log records it. `tick` is its place on the server's clock. */
export class TransactionRecord {
  constructor(
    readonly transaction: Transaction,
    readonly tick: number,
    readonly authorId: string | null,
    readonly status: TransactionStatus,
    readonly reason: string | null,
  ) {}

  /** From a `transactions` row with its `changes`; `null` until the change feed has filed it and given it a tick. */
  static fromLogEntry(entry: {
    id: string;
    tick: number | null;
    authorId: string | null;
    status: string;
    reason: string | null;
    changes: readonly ChangeLogRow[];
  }): TransactionRecord | null {
    const { id, tick, authorId, status, reason, changes } = entry;
    if (tick === null || (status !== "committed" && status !== "denied")) return null;
    return new TransactionRecord(Transaction.fromLogRows(id, changes), tick, authorId, status, reason);
  }

  get id(): string {
    return this.transaction.id;
  }

  get isDenied(): boolean {
    return this.status === "denied";
  }

  outcome(): TransactionOutcome {
    return this.transaction.outcome(this.status, this.tick, this.reason);
  }
}
