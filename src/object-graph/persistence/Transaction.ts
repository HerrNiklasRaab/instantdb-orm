import { runInAction } from "mobx";
import type { Model } from "../Model";
import type { IdentityMap } from "../IdentityMap";
import { getEntityMeta, getPropertyName } from "../store/EntityMeta";
import type { TxChunk } from "./types";
import { ModelSnapshot } from "./ModelSnapshot";

/**
 * Provides access to RootStore internals needed by Transaction.
 * RootStore implements this interface to expose only what's necessary.
 */
export interface TransactionStoreAccess {
  readonly db: { tx: Record<string, Record<string, TxChunk>>; transact(chunks: TxChunk[]): Promise<unknown> };
  getIdentityMaps(): Map<string, IdentityMap<Model>>;
  getIdentityMapByName(entityName: string): IdentityMap<Model>;
  getLinkLabel(entityName: string, linkName: string): string;
}

/**
 * Manages a unit of work - tracking changes and enabling atomic commit or rollback.
 */
export class Transaction {
  private snapshots = new Map<Model, ModelSnapshot>();
  private newModels = new Set<Model>();

  constructor(private store: TransactionStoreAccess) {
    this.captureAllSnapshots();
  }

  /**
   * Capture snapshots of all currently loaded models.
   */
  private captureAllSnapshots(): void {
    for (const identityMap of this.store.getIdentityMaps().values()) {
      for (const model of identityMap.values()) {
        this.snapshots.set(model, new ModelSnapshot(model));
      }
    }
  }

  /**
   * Register a newly created model during this transaction.
   */
  registerNew(model: Model): void {
    if (!this.snapshots.has(model)) {
      this.newModels.add(model);
    }
  }

  /**
   * Commit all dirty models atomically.
   */
  async commit(): Promise<void> {
    const transactions: TxChunk[] = [];

    // Process existing models that have changes
    for (const [model] of this.snapshots) {
      if (model._tracker?.hasChanges()) {
        model.updatedAt = new Date();
        transactions.push(this.buildTransaction(model));
      }
    }

    // Process new models
    for (const model of this.newModels) {
      if (model._tracker?.hasChanges()) {
        model.updatedAt = new Date();
        transactions.push(this.buildTransaction(model));
      }
    }

    if (transactions.length > 0) {
      await this.store.db.transact(transactions);
    }

    // Reset all trackers after successful commit
    for (const [model] of this.snapshots) {
      model._tracker?.reset();
    }
    for (const model of this.newModels) {
      model._tracker?.reset();
    }
  }

  /**
   * Build a transaction chunk for a single model.
   */
  private buildTransaction(model: Model): TxChunk {
    const entityName = model.entityName;
    const changes = model._tracker!.getChanges();
    let tx: TxChunk = this.store.db.tx[entityName][model.id];

    // Scalar updates
    if (changes.scalars.size > 0) {
      const updateData: Record<string, unknown> = {};
      for (const [field, value] of changes.scalars) {
        updateData[field] = value instanceof Date ? value.toISOString() : value;
      }
      tx = tx.update(updateData);
    }

    // Link operations
    for (const [linkName, ids] of changes.links) {
      const label = this.store.getLinkLabel(entityName, linkName);
      tx = tx.link({ [label]: ids.length === 1 ? ids[0] : ids });
    }

    // Unlink operations
    for (const [linkName, ids] of changes.unlinks) {
      const label = this.store.getLinkLabel(entityName, linkName);
      tx = tx.unlink({ [label]: ids.length === 1 ? ids[0] : ids });
    }

    return tx;
  }

  /**
   * Rollback all changes to pre-transaction state.
   */
  rollback(): void {
    runInAction(() => {
      // Restore existing models
      for (const [model, snapshot] of this.snapshots) {
        this.restoreFromSnapshot(model, snapshot);
      }

      // Remove new models from identity maps
      for (const model of this.newModels) {
        const identityMap = this.store.getIdentityMapByName(model.entityName);
        identityMap.delete(model.id);
        model._tracker?.dispose();
      }
    });
  }

  /**
   * Restore a model to its snapshot state.
   */
  private restoreFromSnapshot(model: Model, snapshot: ModelSnapshot): void {
    const entityName = model.entityName;
    const meta = getEntityMeta(entityName);
    const record = model as unknown as Record<string, unknown>;

    // Restore scalar values
    for (const [fieldName, value] of snapshot.scalars) {
      const propName = getPropertyName(model, fieldName);
      record[propName] = value;
    }

    // Restore relationships
    for (const rel of meta.relationshipFields) {
      const propName = getPropertyName(model, rel.fieldName);
      const savedValue = snapshot.relationships.get(rel.fieldName);

      if (rel.isToOne()) {
        const id = savedValue as string | null;
        if (id === null) {
          record[propName] = null;
        } else {
          const targetMap = this.store.getIdentityMapByName(rel.targetEntity);
          record[propName] = targetMap.get(id) ?? null;
        }
      } else {
        const ids = (savedValue as string[]) ?? [];
        const targetMap = this.store.getIdentityMapByName(rel.targetEntity);
        const models = ids
          .map((id) => targetMap.get(id))
          .filter((m): m is Model => m !== undefined);

        // Replace array contents in-place to preserve MobX observable
        const arr = record[propName] as Model[];
        if (Array.isArray(arr)) {
          arr.length = 0;
          arr.push(...models);
        } else {
          record[propName] = models;
        }
      }
    }

    // Reset tracker state
    if (snapshot.wasNew) {
      // Model was new - keep it marked as new
      // (tracker.reset marks it as not new, so we need special handling)
      model._tracker?.dispose();
      model.initTracking();
    } else {
      model._tracker?.reset();
    }
  }
}
