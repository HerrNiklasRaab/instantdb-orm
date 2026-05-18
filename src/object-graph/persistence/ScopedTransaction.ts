import { runInAction } from "mobx";
import { Model } from "../Model";
import type { TxChunk } from "./types";
import { ModelSnapshot } from "./ModelSnapshot";
import { ModelSnapshotDiff } from "./ModelSnapshotDiff";
import { TransactionContext } from "./TransactionContext";
import { getEntityMeta } from "../store/EntityMeta";

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

/**
 * Per-tx, per-model claim. `data` is the snapshot at first touch (the
 * rollback target). `touched` is the set of fields the user has actually
 * mutated in this tx. All three field-level decisions read from `touched`:
 *  - commit emits chunks only for touched fields;
 *  - rollback restores only touched fields to `data` values;
 *  - hydrator skips writes to fields in any active claim's `touched` set.
 */
export interface ClaimRecord {
  readonly data: ModelSnapshot;
  readonly touched: Set<string>;
}

export class ScopedTransaction {
  private claimedModels = new Map<Model, ClaimRecord>();
  private newModels = new Set<Model>();
  private finalized = false;

  constructor(private store: TransactionStoreAccess) {}

  /**
   * Claim an existing model for this transaction AND mark `fieldName` as
   * user-touched. Called from MobX interceptors with the schema field name
   * that's about to be mutated. Captures the model snapshot on first claim;
   * subsequent calls only extend the touched set.
   *
   * New models (already in newModels) don't get claimed — they emit their
   * full state at commit, no touched-set needed.
   */
  claim(model: Model, fieldName: string): void {
    this.assertActive();
    if (this.newModels.has(model)) return;

    let record = this.claimedModels.get(model);
    if (!record) {
      record = { data: new ModelSnapshot(model), touched: new Set() };
      this.claimedModels.set(model, record);
      if (!model._activeClaims) model._activeClaims = new Set();
      model._activeClaims.add(record);
    }
    record.touched.add(fieldName);
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
   * Commit this transaction's claimed and newly-registered models.
   *
   * For claimed (existing) models, emit chunks for fields in the touched
   * set — not for every field that drifted from claim.data. Hydrator writes
   * to untouched fields are NOT re-emitted from this tx.
   *
   * New models emit their full current state (diff against an empty
   * baseline).
   */
  async commit(): Promise<void> {
    this.assertActive();
    try {
      const chunks = TransactionContext.run(this, () => {
        const built: TxChunk[] = [];
        for (const [model, claim] of this.claimedModels) {
          if (claim.touched.size === 0) continue;
          model.setUpdatedAt();
          const chunk = this.buildChunkFromTouched(model, claim);
          if (chunk) built.push(chunk);
        }
        for (const model of this.newModels) {
          // Bump updatedAt BEFORE snapshotting so the diff carries the
          // bumped timestamp out to the DB.
          model.setUpdatedAt();
          const diff = this.diffNew(model);
          if (!diff.hasChanges()) continue;
          built.push(this.buildTxChunkFromDiff(model, diff));
        }
        return built;
      });

      if (chunks.length > 0) {
        await this.store.db.transact(chunks);
      }
    } finally {
      this.releaseAll();
    }
  }

  private diffNew(model: Model): ModelSnapshotDiff {
    return new ModelSnapshotDiff(
      ModelSnapshot.emptyOriginal(),
      new ModelSnapshot(model),
      model.entityName,
      true
    );
  }

  /**
   * Rollback all changes to pre-transaction state.
   *
   * For claimed models: restore ONLY the fields the user touched, back to
   * their claim.data value. Untouched fields (which may have been written
   * by mid-tx hydration of remote updates) are left alone.
   *
   * For new models: drop from the identity map and dispose their observers.
   */
  rollback(): void {
    this.assertActive();
    try {
      runInAction(() => {
        for (const [model, claim] of this.claimedModels) {
          this.restoreTouchedFields(model, claim);
        }

        for (const model of this.newModels) {
          const identityMap = this.store.getIdentityMapByName(model.entityName);
          identityMap.delete(model.id);
          model.disposeTracking();
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

  private restoreTouchedFields(model: Model, claim: ClaimRecord): void {
    if (claim.touched.size === 0) return;
    const fields = [...claim.touched];
    // Clear our own touched set so the hydrator's isFieldTouched check
    // doesn't refuse to overwrite the fields we're trying to restore.
    // (We're about to release the claim anyway via releaseAll.)
    claim.touched.clear();

    const fullRaw = claim.data.toRawEntityData(model.id);
    const filtered: { id: string; [key: string]: unknown } = { id: model.id };
    for (const fieldName of fields) {
      if (fieldName in fullRaw) {
        filtered[fieldName] = fullRaw[fieldName];
      }
    }
    this.store.rehydrateModel(model, filtered);
  }

  private buildChunkFromTouched(model: Model, claim: ClaimRecord): TxChunk | null {
    const entityName = model.entityName;
    const meta = getEntityMeta(entityName);

    const updateData: Record<string, unknown> = {};
    const links = new Map<string, string[]>();
    const unlinks = new Map<string, string[]>();

    for (const fieldName of claim.touched) {
      const scalarField = meta.scalarFields.find(f => f.fieldName === fieldName);
      if (scalarField && scalarField.fieldName !== "id") {
        const value = scalarField.read(model);
        updateData[fieldName] = value instanceof Date ? value.toISOString() : value;
        continue;
      }

      const relField = meta.relationshipFields.find(r => r.fieldName === fieldName);
      if (!relField) continue;
      const value = relField.read(model);

      if (relField.isToOne()) {
        const currentId = value instanceof Model ? value.id : null;
        const original = claim.data.relationships.get(fieldName);
        const originalId = typeof original === "string" ? original : null;
        if (currentId !== originalId) {
          if (originalId) {
            this.pushInto(unlinks, relField.linkName, originalId);
          }
          if (currentId) {
            this.pushInto(links, relField.linkName, currentId);
          }
        }
      } else {
        const currentIds: string[] = [];
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item instanceof Model) currentIds.push(item.id);
          }
        }
        const original = claim.data.relationships.get(fieldName);
        const originalIds = Array.isArray(original) ? original : [];
        const origSet = new Set(originalIds);
        const currSet = new Set(currentIds);
        for (const id of currSet) {
          if (!origSet.has(id)) this.pushInto(links, relField.linkName, id);
        }
        for (const id of origSet) {
          if (!currSet.has(id)) this.pushInto(unlinks, relField.linkName, id);
        }
      }
    }

    if (Object.keys(updateData).length === 0 && links.size === 0 && unlinks.size === 0) {
      return null;
    }

    let tx: TxChunk = this.store.db.tx[entityName][model.id];
    if (Object.keys(updateData).length > 0) {
      tx = tx.update(updateData);
    }
    for (const [linkName, ids] of links) {
      const label = this.store.getLinkLabel(entityName, linkName);
      tx = tx.link({ [label]: ids.length === 1 ? ids[0] : ids });
    }
    for (const [linkName, ids] of unlinks) {
      const label = this.store.getLinkLabel(entityName, linkName);
      tx = tx.unlink({ [label]: ids.length === 1 ? ids[0] : ids });
    }
    return tx;
  }

  private pushInto(map: Map<string, string[]>, key: string, value: string): void {
    const arr = map.get(key) ?? [];
    arr.push(value);
    map.set(key, arr);
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

  private releaseAll(): void {
    for (const [model, record] of this.claimedModels) {
      model._activeClaims?.delete(record);
      if (model._activeClaims && model._activeClaims.size === 0) {
        model._activeClaims = null;
      }
    }
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
