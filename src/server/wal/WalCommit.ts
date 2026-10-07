import type { RowSnapshot } from "../../buckets/BucketScheme";
import type { Row } from "../../queries";
import type { ReplicatedTables } from "./ReplicatedTables";
import type { WalTransaction } from "./PgOutputDecoder";

const LOG_TABLE = "transactions";

type ReadColumns = (entity: string, ids: readonly string[]) => Promise<ReadonlyMap<string, Row>>;

class SnapshotBuilder {
  readonly before = new Map<string, Map<string, Row>>();
  readonly after = new Map<string, Map<string, Row>>();
  private readonly seen = new Map<string, Set<string>>();

  /** A row this transaction wrote: the first old value is how it was before, the last new value how it is now. */
  wrote(entity: string, id: string, before: Row | null, after: Row | null): void {
    if (!this.markSeen(entity, id) && before) this.rows(this.before, entity).set(id, before);
    if (after) this.rows(this.after, entity).set(id, after);
    else this.after.get(entity)?.delete(id);
  }

  /** A row the transaction linked to or from without writing it: the same before and after. */
  unchanged(entity: string, row: Row): void {
    if (this.markSeen(entity, row.id)) return;
    this.rows(this.before, entity).set(row.id, row);
    this.rows(this.after, entity).set(row.id, row);
  }

  isSeen(entity: string, id: string): boolean {
    return this.seen.get(entity)?.has(id) ?? false;
  }

  private markSeen(entity: string, id: string): boolean {
    const ids = this.seen.get(entity) ?? new Set<string>();
    this.seen.set(entity, ids);
    const already = ids.has(id);
    ids.add(id);
    return already;
  }

  private rows(snapshot: Map<string, Map<string, Row>>, entity: string): Map<string, Row> {
    const rows = snapshot.get(entity) ?? new Map<string, Row>();
    snapshot.set(entity, rows);
    return rows;
  }
}

/** One committed database transaction read from the WAL, in the sync engine's terms. */
export class WalCommit {
  constructor(
    private readonly wal: WalTransaction,
    private readonly tables: ReplicatedTables,
  ) {}

  get commitLsn(): WalTransaction["commitLsn"] {
    return this.wal.commitLsn;
  }

  /**
   * The id of the sync transaction this commit logged, if a sync server
   * wrote it. Only the server's own log insert leaves the tick empty; the
   * feed's row for an outside write carries its tick already.
   */
  logEntryId(): string | null {
    const ids = this.wal.changes
      .filter((change) => change.table === LOG_TABLE && change.before === null && change.after?.tick === null)
      .map((change) => change.after?.id)
      .filter((id): id is string => typeof id === "string");
    if (ids.length > 1) throw new Error(`One database transaction logged ${ids.length} sync transactions: ${ids.join(", ")}.`);
    return ids[0] ?? null;
  }

  /** Whether it wrote anything clients replicate. The feed's own bookkeeping writes nothing of the kind. */
  touchesSyncedRows(): boolean {
    return this.wal.changes.some((change) => this.tables.isEntity(change.table) || this.tables.joinTable(change.table) !== null);
  }

  /**
   * The written rows before and after the commit, plus, unchanged, the rows
   * at the other end of every link written: what a link changes for them is
   * their relation, which clients holding them re-read.
   */
  async snapshot(readColumns: ReadColumns): Promise<{ before: RowSnapshot; after: RowSnapshot }> {
    const builder = new SnapshotBuilder();
    const linked = new Map<string, Set<string>>();
    const link = (entity: string, id: string): void => {
      linked.set(entity, (linked.get(entity) ?? new Set()).add(id));
    };
    for (const change of this.wal.changes) {
      const join = this.tables.joinTable(change.table);
      if (join) {
        for (const tuple of [change.before, change.after]) {
          if (typeof tuple?.A === "string") link(join.ends.A, tuple.A);
          if (typeof tuple?.B === "string") link(join.ends.B, tuple.B);
        }
        continue;
      }
      if (!this.tables.isEntity(change.table)) continue;
      const before = change.before ? this.tables.row(change.table, change.before) : null;
      const after = change.after ? this.tables.row(change.table, change.after) : null;
      const id = (after ?? before)?.id;
      if (id === undefined) continue;
      builder.wrote(change.table, id, before, after);
      for (const target of this.tables.relinked(change.table, before, after)) link(target.entity, target.id);
    }
    for (const [entity, ids] of linked) {
      const unseen = [...ids].filter((id) => !builder.isSeen(entity, id));
      if (unseen.length === 0) continue;
      for (const row of (await readColumns(entity, unseen)).values()) builder.unchanged(entity, row);
    }
    return { before: builder.before, after: builder.after };
  }
}
