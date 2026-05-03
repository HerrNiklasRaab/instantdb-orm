import { runInAction } from "mobx";
import type { Model } from "../Model";
import type { TxChunk } from "./types";
import { ModelSnapshot } from "./ModelSnapshot";
import { ModelSnapshotDiff } from "./ModelSnapshotDiff";
import { TransactionContext } from "./TransactionContext";

export interface TransactionStoreAccess {
  readonly db: { tx: Record<string, Record<string, TxChunk>>; transact(chunks: TxChunk[]): Promise<unknown> };
  getIdentityMapByName(entityName: string): {
    has(id: string): boolean;
    set(model: Model): void;
    delete(id: string): boolean;
  };
  getLinkLabel(entityName: string, linkName: string): string;
  rehydrateModel(model: Model, rawData: { id: string; [key: string]: unknown }): void;
}

export class ScopedTransaction {
  private claimedModels = new Map<Model, ModelSnapshot>();
  private newModels = new Set<Model>();
  private finalized = false;

  constructor(private store: TransactionStoreAccess) {}

  /**
   * Claim an existing model for this transaction.
   * Captures a snapshot BEFORE the mutation lands (called from MobX interceptor).
   */
  claim(model: Model): void {
    this.assertActive();
    if (this.claimedModels.has(model) || this.newModels.has(model)) {
      return;
    }
    this.claimedModels.set(model, new ModelSnapshot(model));
  }

  /**
   * Register a newly created model during this transaction.
   */
  registerNew(model: Model): void {
    this.assertActive();
    if (this.newModels.has(model)) {
      return;
    }
    this.newModels.add(model);

    const identityMap = this.store.getIdentityMapByName(model.entityName);
    if (!identityMap.has(model.id)) {
      identityMap.set(model);
    }
  }

  has(model: Model): boolean {
    return this.claimedModels.has(model) || this.newModels.has(model);
  }

  /**
   * Run a callback within this transaction's context.
   * Any model mutations inside the callback are auto-claimed.
   */
  run<T>(fn: () => T): T {
    this.assertActive();
    return TransactionContext.run(this, fn);
  }

  /**
   * Commit only this transaction's claimed models atomically.
   *
   * Existing (claimed) models are diffed against the snapshot taken at
   * *claim time* — so only mutations that happened inside this transaction
   * are persisted. Out-of-transaction mutations or hydration side effects
   * accumulated earlier are not flushed.
   */
  async commit(): Promise<void> {
    this.assertActive();
    try {
      const chunks: TxChunk[] = [];

      for (const [model, claimSnapshot] of this.claimedModels) {
        if (!this.diffFromClaim(model, claimSnapshot).hasChanges()) continue;
        model.setUpdatedAt();
        chunks.push(this.buildTxChunkFromDiff(model, this.diffFromClaim(model, claimSnapshot)));
      }

      for (const model of this.newModels) {
        if (model._tracker?.hasChanges()) {
          model.setUpdatedAt();
          chunks.push(this.buildTxChunk(model));
        }
      }

      if (chunks.length > 0) {
        await this.store.db.transact(chunks);
      }

      for (const [model] of this.claimedModels) {
        model._tracker?.reset();
      }
      for (const model of this.newModels) {
        model._tracker?.reset();
      }
    } finally {
      this.releaseAll();
    }
  }

  private diffFromClaim(model: Model, claimSnapshot: ModelSnapshot): ModelSnapshotDiff {
    return new ModelSnapshotDiff(
      claimSnapshot,
      new ModelSnapshot(model, false),
      model.entityName,
      false
    );
  }

  /**
   * Rollback all changes to pre-transaction state.
   */
  rollback(): void {
    this.assertActive();
    try {
      runInAction(() => {
        for (const [model, snapshot] of this.claimedModels) {
          this.restoreFromSnapshot(model, snapshot);
        }

        for (const model of this.newModels) {
          const identityMap = this.store.getIdentityMapByName(model.entityName);
          identityMap.delete(model.id);
          model._tracker?.dispose();
        }
      });
    } finally {
      this.releaseAll();
    }
  }

  dispose(): void {
    if (!this.finalized) {
      this.releaseAll();
    }
  }

  private buildTxChunk(model: Model): TxChunk {
    return this.buildTxChunkFromDiff(model, model._tracker!.getChanges());
  }

  private buildTxChunkFromDiff(model: Model, diff: ModelSnapshotDiff): TxChunk {
    const entityName = model.entityName;
    let tx: TxChunk = this.store.db.tx[entityName][model.id];

    if (diff.scalars.size > 0) {
      const updateData: Record<string, unknown> = {};
      for (const [field, value] of diff.scalars) {
        updateData[field] = value instanceof Date ? value.toISOString() : value;
      }
      tx = tx.update(updateData);
    }

    for (const [linkName, ids] of diff.links) {
      const label = this.store.getLinkLabel(entityName, linkName);
      tx = tx.link({ [label]: ids.length === 1 ? ids[0] : ids });
    }

    for (const [linkName, ids] of diff.unlinks) {
      const label = this.store.getLinkLabel(entityName, linkName);
      tx = tx.unlink({ [label]: ids.length === 1 ? ids[0] : ids });
    }

    return tx;
  }

  private restoreFromSnapshot(model: Model, snapshot: ModelSnapshot): void {
    const rawData = snapshot.toRawEntityData(model.id);
    this.store.rehydrateModel(model, rawData);

    if (snapshot.wasNew) {
      model._tracker?.dispose();
      model.initTracking();
    } else {
      model._tracker?.reset();
    }
  }

  private releaseAll(): void {
    this.claimedModels.clear();
    this.newModels.clear();
    this.finalized = true;
  }

  private assertActive(): void {
    if (this.finalized) {
      throw new Error("Transaction has already been finalized");
    }
  }
}
