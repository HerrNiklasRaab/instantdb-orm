import { observe } from "mobx";
import type { Model } from "../Model";
import type { EntityName } from "../store/EntityMeta";
import { getEntityMeta } from "../store/EntityMeta";
import { ModelSnapshot } from "./ModelSnapshot";
import { ModelSnapshotDiff } from "./ModelSnapshotDiff";

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
  isNew(): boolean {
    return this._isNew;
  }

  /** Mark entity as not new (already exists in database) */
  markNotNew(): void {
    this._isNew = false;
  }

  private setupObservers(): void {
    const meta = getEntityMeta(this.entityName);
    const record = this.model as unknown as Record<string, unknown>;

    // Observe scalar field changes (use private backing field if exists)
    for (const field of meta.scalarFields) {
      if (field.fieldName === "id") continue;
      const propName = field.getFieldNameOnModel(this.model);

      try {
        const disposer = observe(
          this.model as object,
          propName as never,
          (change) => {
            if (change.type === "update") {
              this.currentSnapshot = new ModelSnapshot(this.model, this._isNew);
            }
          }
        );
        this.disposers.push(disposer);
      } catch {
        // Field might not be observable, skip it
      }
    }

    // Observe relationship changes (use private backing field if exists)
    for (const rel of meta.relationshipFields) {
      const propName = rel.getFieldNameOnModel(this.model);

      if (rel.isToOne()) {
        // observable.ref - observe the reference change
        try {
          const disposer = observe(
            this.model as object,
            propName as never,
            (change) => {
              if (change.type === "update") {
                this.currentSnapshot = new ModelSnapshot(this.model, this._isNew);
              }
            }
          );
          this.disposers.push(disposer);
        } catch {
          // Field might not be observable, skip it
        }
      } else {
        // observable.shallow - observe array changes
        const array = record[propName] as Model[] | undefined;
        if (array && Array.isArray(array)) {
          try {
            const disposer = observe(array, () => {
              this.currentSnapshot = new ModelSnapshot(this.model, this._isNew);
            });
            this.disposers.push(disposer);
          } catch {
            // Array might not be observable, skip it
          }
        }
      }
    }
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

  dispose(): void {
    for (const disposer of this.disposers) {
      disposer();
    }
    this.disposers = [];
  }
}
