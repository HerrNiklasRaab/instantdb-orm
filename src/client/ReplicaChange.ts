import type { QueryResult } from "../queries";
import type { Transaction } from "../transactions";

/**
 * What one server message changed in the replica: rows written, rows
 * removed, and whole models whose rows went by a filter rather than by id
 * (a lost bucket, a resync), so only a full read tells what is left.
 */
export class ReplicaChange {
  private readonly written = new Map<string, Set<string>>();
  private readonly dropped = new Map<string, Set<string>>();
  private readonly wholeModels = new Set<string>();

  /** The rows this client's own transaction wrote or deleted. */
  static ofTransaction(transaction: Transaction): ReplicaChange {
    const change = new ReplicaChange();
    for (const entry of transaction.changes) {
      if (entry.kind === "delete") change.idsIn(change.dropped, entry.entity).add(entry.id);
      else change.idsIn(change.written, entry.entity).add(entry.id);
    }
    return change;
  }

  static ofRows(rows: QueryResult, removed: Readonly<Record<string, readonly string[]>> = {}): ReplicaChange {
    const change = new ReplicaChange();
    change.addRows(rows);
    change.addRemoved(removed);
    return change;
  }

  addRows(rows: QueryResult): void {
    for (const [entity, entityRows] of Object.entries(rows)) {
      for (const row of entityRows) {
        if (typeof row.id === "string") this.idsIn(this.written, entity).add(row.id);
      }
    }
  }

  addRemoved(removed: Readonly<Record<string, readonly string[]>>): void {
    for (const [entity, ids] of Object.entries(removed)) {
      for (const id of ids) this.idsIn(this.dropped, entity).add(id);
    }
  }

  addWholeModel(model: string): void {
    this.wholeModels.add(model);
  }

  /** Everything in `other` as well: the union, for changes applied as one. */
  absorb(other: ReplicaChange): void {
    for (const [entity, ids] of other.written) for (const id of ids) this.idsIn(this.written, entity).add(id);
    for (const [entity, ids] of other.dropped) for (const id of ids) this.idsIn(this.dropped, entity).add(id);
    for (const model of other.wholeModels) this.wholeModels.add(model);
  }

  /** Hands over what is accumulated and starts empty. */
  take(): ReplicaChange {
    const taken = new ReplicaChange();
    taken.absorb(this);
    this.clear();
    return taken;
  }

  clear(): void {
    this.written.clear();
    this.dropped.clear();
    this.wholeModels.clear();
  }

  get isEmpty(): boolean {
    return this.written.size === 0 && this.dropped.size === 0 && this.wholeModels.size === 0;
  }

  /** Ids written per model, leaving out models that are read whole anyway. */
  writtenIds(): [string, string[]][] {
    return this.byModel(this.written);
  }

  removedIds(): [string, string[]][] {
    return this.byModel(this.dropped);
  }

  models(): string[] {
    return [...this.wholeModels];
  }

  private byModel(map: Map<string, Set<string>>): [string, string[]][] {
    return [...map].filter(([entity]) => !this.wholeModels.has(entity)).map(([entity, ids]) => [entity, [...ids]]);
  }

  private idsIn(map: Map<string, Set<string>>, entity: string): Set<string> {
    const ids = map.get(entity) ?? new Set<string>();
    map.set(entity, ids);
    return ids;
  }
}
