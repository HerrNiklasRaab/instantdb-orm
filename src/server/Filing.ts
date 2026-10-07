import type { BucketEntry } from "../buckets/BucketEntry";
import type { TransactionRecord } from "./TransactionRecord";

/** A logged transaction together with where its rows were filed and whose held buckets it may have changed. */
export class Filing {
  constructor(
    readonly record: TransactionRecord,
    readonly entries: readonly BucketEntry[],
    /** Identities whose parameter queries read a row this transaction touched. */
    readonly affectedIdentities: ReadonlySet<string>,
  ) {}

  static verdictOnly(record: TransactionRecord): Filing {
    return new Filing(record, [], new Set());
  }

  get tick(): number {
    return this.record.tick;
  }

  entriesIn(buckets: ReadonlySet<string>): BucketEntry[] {
    return this.entries.filter((entry) => buckets.has(entry.bucket));
  }

  affects(identityId: string | null): boolean {
    return identityId !== null && this.affectedIdentities.has(identityId);
  }
}
