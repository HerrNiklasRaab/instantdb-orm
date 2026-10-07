import type { BucketEntry } from "./BucketEntry";

/**
 * Bucket entries folded down to rows: which rows are present and which are
 * gone, after every entry has had its say. Entries of one log tick are a
 * group; a later group overrides an earlier one, and within a group a row
 * that is present in any bucket counts as present.
 */
export class TouchedRows {
  private constructor(
    readonly present: ReadonlyMap<string, ReadonlySet<string>>,
    readonly removed: ReadonlyMap<string, ReadonlySet<string>>,
    readonly buckets: ReadonlySet<string>,
  ) {}

  static fromGroups(groups: readonly (readonly BucketEntry[])[]): TouchedRows {
    const state = new Map<string, Map<string, boolean>>();
    const buckets = new Set<string>();
    for (const group of groups) {
      const decided = new Map<string, Map<string, boolean>>();
      for (const entry of group) {
        buckets.add(entry.bucket);
        const rows = decided.get(entry.entity) ?? decided.set(entry.entity, new Map()).get(entry.entity);
        rows?.set(entry.entityId, (rows.get(entry.entityId) ?? false) || !entry.removed);
      }
      for (const [entity, rows] of decided) {
        const target = state.get(entity) ?? state.set(entity, new Map()).get(entity);
        for (const [id, present] of rows) target?.set(id, present);
      }
    }
    const present = new Map<string, Set<string>>();
    const removed = new Map<string, Set<string>>();
    for (const [entity, rows] of state) {
      for (const [id, isPresent] of rows) {
        const into = isPresent ? present : removed;
        (into.get(entity) ?? into.set(entity, new Set()).get(entity))?.add(id);
      }
    }
    return new TouchedRows(present, removed, buckets);
  }

  get isEmpty(): boolean {
    return this.present.size === 0 && this.removed.size === 0;
  }
}
