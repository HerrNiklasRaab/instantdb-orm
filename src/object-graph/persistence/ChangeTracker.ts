import { observe, intercept } from "mobx";
import type { Model } from "../Model";
import type { EntityName } from "../store/EntityMeta";
import { getEntityMeta, RelationshipFieldMeta } from "../store/EntityMeta";
import { wireReverseLink, isWiringInProgress } from "../store/reverseLinkWiring";
import { isHydrationInProgress } from "../store/hydrationContext";
import { ModelSnapshot } from "./ModelSnapshot";
import { ModelSnapshotDiff } from "./ModelSnapshotDiff";
import { TransactionContext } from "./TransactionContext";

export class ChangeTracker {
  private disposers: (() => void)[] = [];
  private originalSnapshot: ModelSnapshot;
  private currentSnapshot: ModelSnapshot;
  private _isNew = true;

  constructor(
    private model: Model,
    private entityName: EntityName,
    isNew: boolean = true
  ) {
    this._isNew = isNew;
    this.originalSnapshot = isNew
      ? ModelSnapshot.emptyOriginal()
      : new ModelSnapshot(model, false);
    this.currentSnapshot = new ModelSnapshot(model, isNew);
    this.setupObservers();
  }

  /** Returns true if entity has never been saved */
  get isNew(): boolean {
    return this._isNew;
  }

  private setupObservers(): void {
    const meta = getEntityMeta(this.entityName);
    const record = this.model as unknown as Record<string, unknown>;

    for (const field of meta.fields) {
      if (field.fieldName === "id") continue;
      const propName = field.getFieldNameOnModel(this.model);

      // To-many relationships need array observer
      if (field instanceof RelationshipFieldMeta && field.isToMany()) {
        const rel = field;
        const array = record[propName] as Model[] | undefined;
        if (array && Array.isArray(array)) {
          try {
            const disposer = observe(array, (change) => {
              if (change.type === "splice") {
                for (const added of change.added as Model[]) {
                  wireReverseLink(this.model, added, rel, true);
                }
                for (const removed of change.removed as Model[]) {
                  wireReverseLink(this.model, removed, rel, false);
                }
              }
              this.updateSnapshot();
            });
            this.disposers.push(disposer);
          } catch {
            // Array might not be observable, skip it
          }
          try {
            const interceptDisposer = intercept(array, (change) => {
              this.claimForCurrentTransaction();
              if (change.type === "splice") {
                // Drop adds for items already present so push() is idempotent
                const filteredAdded = change.added.filter(
                  (item) => !array.includes(item as Model)
                );
                if (
                  filteredAdded.length === 0 &&
                  change.removedCount === 0
                ) {
                  return null;
                }
                change.added = filteredAdded;
              }
              return change;
            });
            this.disposers.push(interceptDisposer);
          } catch {
            // Array might not be observable, skip it
          }
        }
        continue;
      }

      // Scalars and to-one relationships use property observer + interceptor
      try {
        const interceptDisposer = intercept(
          this.model as object,
          propName as never,
          (change) => {
            this.claimForCurrentTransaction();
            return change;
          }
        );
        this.disposers.push(interceptDisposer);
      } catch {
        // Field might not be observable, skip it
      }

      try {
        const isToOneRel =
          field instanceof RelationshipFieldMeta && field.isToOne();
        const rel = isToOneRel ? (field as RelationshipFieldMeta) : null;
        const disposer = observe(
          this.model as object,
          propName as never,
          (change: any) => {
            if (change.type === "update") {
              if (rel) {
                const oldVal = change.oldValue as Model | null | undefined;
                const newVal = change.newValue as Model | null | undefined;
                if (oldVal && oldVal !== newVal) {
                  wireReverseLink(this.model, oldVal, rel, false);
                }
                if (newVal && oldVal !== newVal) {
                  wireReverseLink(this.model, newVal, rel, true);
                }
              }
              this.updateSnapshot();
            }
          }
        );
        this.disposers.push(disposer);
      } catch {
        // Field might not be observable, skip it
      }
    }
  }

  private claimForCurrentTransaction(): void {
    // Skip claims that originate from reverse-link wiring. The wirer's
    // mutation on the wired side is bookkeeping (the forward-side row's
    // `link` op is what InstantDB persists), so the wired side should not
    // be drawn into the active transaction's commit.
    if (isWiringInProgress()) return;
    // Hydration writes scalars and relationships through MobX-observed
    // properties; those mutations are framework-internal, not user intent.
    if (isHydrationInProgress()) return;
    const tx = TransactionContext.current;
    if (!tx) {
      throw new Error(
        `Cannot mutate ${this.entityName} ${this.model.id} outside of a transaction. ` +
        `Wrap the mutation in store.transaction(() => ...).`
      );
    }
    if (!tx.has(this.model)) {
      tx.claim(this.model);
    }
  }

  private updateSnapshot(): void {
    this.currentSnapshot = new ModelSnapshot(this.model, this._isNew);
  }

  getChanges(): ModelSnapshotDiff {
    return new ModelSnapshotDiff(
      this.originalSnapshot,
      this.currentSnapshot,
      this.entityName,
      this._isNew
    );
  }

  hasChanges(): boolean {
    if (this._isNew) {
      return true;
    }
    return this.getChanges().hasChanges();
  }

  reset(): void {
    this._isNew = false;
    this.originalSnapshot = new ModelSnapshot(this.model, false);
    this.currentSnapshot = this.originalSnapshot;
  }

  /**
   * Returns a clone of `originalSnapshot` suitable for later restoration
   * via `restoreOriginal`. Cloning is required because
   * `acceptRelationshipDelta` mutates the live `originalSnapshot` — a
   * plain reference would silently change.
   */
  snapshotOriginal(): ModelSnapshot {
    return this.originalSnapshot.clone();
  }

  /**
   * Restore `originalSnapshot` to a previously-captured snapshot. Used by
   * ScopedTransaction.rollback to undo wirer-driven mutations to
   * `originalSnapshot` that happened during the transaction, preserving
   * any pre-transaction local diff between current and original.
   */
  restoreOriginal(original: ModelSnapshot): void {
    this._isNew = false;
    this.originalSnapshot = original;
    this.currentSnapshot = new ModelSnapshot(this.model, false);
  }

  /**
   * Apply a single add/remove delta to `originalSnapshot` for one
   * relationship. Used by reverse-link wiring: when the wirer
   * pushes/sets/splices on the wired side, that mutation is bookkeeping
   * (not user intent), so `originalSnapshot` should track the *same*
   * delta — leaving any independent local diff on the wired side intact.
   *
   * Critically this is NOT "set originalSnapshot to current state." That
   * would absorb unrelated local edits — including, during hydration,
   * edits that haven't been saved yet.
   */
  acceptRelationshipDelta(fieldName: string, targetId: string, add: boolean): void {
    const meta = getEntityMeta(this.entityName);
    const rel = meta.relationshipFields.find((r) => r.fieldName === fieldName);
    if (!rel) return;
    const original = this.originalSnapshot.relationships;

    if (rel.isToMany()) {
      const ids = (original.get(fieldName) as string[] | undefined) ?? [];
      if (add) {
        if (!ids.includes(targetId)) {
          original.set(fieldName, [...ids, targetId]);
        }
      } else {
        original.set(fieldName, ids.filter((id) => id !== targetId));
      }
    } else {
      original.set(fieldName, add ? targetId : null);
    }
  }

  dispose(): void {
    for (const disposer of this.disposers) {
      disposer();
    }
    this.disposers = [];
  }
}
