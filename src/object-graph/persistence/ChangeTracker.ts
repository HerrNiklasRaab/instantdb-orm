import { observe, intercept } from "mobx";
import type { Model } from "../Model";
import type { EntityName } from "../store/EntityMeta";
import { getEntityMeta, RelationshipFieldMeta } from "../store/EntityMeta";
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
    this.originalSnapshot = new ModelSnapshot(model, isNew);
    this.currentSnapshot = this.originalSnapshot;
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
        const array = record[propName] as Model[] | undefined;
        if (array && Array.isArray(array)) {
          try {
            const disposer = observe(array, () => this.updateSnapshot());
            this.disposers.push(disposer);
          } catch {
            // Array might not be observable, skip it
          }
          try {
            const interceptDisposer = intercept(array, (change) => {
              this.claimForCurrentTransaction();
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
        const disposer = observe(
          this.model as object,
          propName as never,
          (change) => {
            if (change.type === "update") {
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
    const tx = TransactionContext.current;
    if (tx && !tx.has(this.model)) {
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
   * Treat the current value of one relationship as part of the baseline.
   * Used by ModelHydrator's reverse-link wiring: when a child is
   * late-hydrated and pushed into a parent's array, that push is
   * bookkeeping, not a user mutation, so it must not show up as a change.
   */
  acceptCurrentRelationship(fieldName: string): void {
    const meta = getEntityMeta(this.entityName);
    const rel = meta.relationshipFields.find((r) => r.fieldName === fieldName);
    if (!rel) return;
    const propName = rel.getFieldNameOnModel(this.model);
    const value = (this.model as unknown as Record<string, unknown>)[propName];
    const baseline = rel.isToMany()
      ? ((value as Model[] | undefined) ?? []).map((m) => m.id)
      : ((value as Model | null)?.id ?? null);
    this.originalSnapshot.relationships.set(fieldName, baseline);
  }

  dispose(): void {
    for (const disposer of this.disposers) {
      disposer();
    }
    this.disposers = [];
  }
}
