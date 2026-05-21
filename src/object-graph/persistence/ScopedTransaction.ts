import { runInAction } from "mobx";
import type { LinkParams, TransactionChunk, TxChunk, UpdateParams } from "@instantdb/core";
import type { AnySchema } from "../../instantdb";
import { Model } from "../Model";
import { ModelSnapshot } from "./ModelSnapshot";
import { ModelSnapshotDiff } from "./ModelSnapshotDiff";
import { TransactionContext } from "./TransactionContext";
import { getEntityAttrs, getEntityLinks, readField } from "../store/EntityMeta";

type SchemaChunk<Schema extends AnySchema> = TransactionChunk<
  Schema,
  keyof Schema["entities"] & string
>;

export interface TransactionStoreAccess<Schema extends AnySchema> {
  readonly db: {
    tx: TxChunk<Schema>;
    transact(chunks: SchemaChunk<Schema>[]): Promise<unknown>;
  };
  getIdentityMapByName(entityName: string): {
    has(id: string): boolean;
    set(model: Model): void;
    delete(id: string): boolean;
  };
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

/**
 * Members are all Schema-free in signature and the typed store is held in
 * closures bound at construction. That makes the class structurally
 * identical across Schema instantiations, so `TransactionContext` can hold
 * any `ScopedTransaction<S>` without a non-generic supertype interface.
 */
export class ScopedTransaction<Schema extends AnySchema> {
  readonly claim: (model: Model, fieldName: string) => void;
  readonly registerNew: (model: Model) => void;
  readonly has: (model: Model) => boolean;
  readonly run: <T>(fn: () => T) => T;
  readonly commit: () => Promise<void>;
  readonly rollback: () => void;
  readonly dispose: () => void;

  constructor(store: TransactionStoreAccess<Schema>) {
    const claimedModels = new Map<Model, ClaimRecord>();
    const newModels = new Set<Model>();
    let finalized = false;

    const assertActive = (): void => {
      if (finalized) {
        throw new Error("Transaction has already been finalized");
      }
    };

    const releaseAll = (): void => {
      for (const [model, record] of claimedModels) {
        model._activeClaims?.delete(record);
        if (model._activeClaims && model._activeClaims.size === 0) {
          model._activeClaims = null;
        }
      }
      claimedModels.clear();
      newModels.clear();
      finalized = true;
    };

    const restoreTouchedFields = (model: Model, claim: ClaimRecord): void => {
      if (claim.touched.size === 0) return;
      const fields = [...claim.touched];
      // Clear the touched set so the hydrator's isFieldTouched check
      // doesn't refuse to overwrite the fields we're restoring.
      claim.touched.clear();

      const fullRaw = claim.data.toRawEntityData(model.id);
      const filtered: { id: string; [key: string]: unknown } = { id: model.id };
      for (const fieldName of fields) {
        if (fieldName in fullRaw) {
          filtered[fieldName] = fullRaw[fieldName];
        }
      }
      store.rehydrateModel(model, filtered);
    };

    const appendLink = (
      target: LinkParams<Schema, keyof Schema["entities"] & string>,
      label: string,
      id: string
    ): boolean => {
      const existing: unknown = Reflect.get(target, label);
      if (existing === undefined) {
        Reflect.set(target, label, id);
        return true;
      }
      if (typeof existing === "string") {
        Reflect.set(target, label, [existing, id]);
        return true;
      }
      if (Array.isArray(existing)) {
        existing.push(id);
        return true;
      }
      return false;
    };

    const txFor = (model: Model): SchemaChunk<Schema> => {
      const entityTx = store.db.tx[model.entityName];
      if (!entityTx) {
        throw new Error(`Unknown entity type: ${model.entityName}`);
      }
      const tx = entityTx[model.id];
      if (!tx) {
        throw new Error(`Missing tx chunk for ${model.entityName}:${model.id}`);
      }
      return tx;
    };

    const buildChunkFromTouched = (
      model: Model,
      claim: ClaimRecord
    ): SchemaChunk<Schema> | null => {
      const entityName = model.entityName;
      const attrs = getEntityAttrs(entityName);
      const links_ = getEntityLinks(entityName);

      const updateData: UpdateParams<Schema, keyof Schema["entities"] & string> = {};
      const links: LinkParams<Schema, keyof Schema["entities"] & string> = {};
      const unlinks: LinkParams<Schema, keyof Schema["entities"] & string> = {};
      let hasUpdates = false;
      let hasLinks = false;
      let hasUnlinks = false;

      for (const fieldName of claim.touched) {
        if (fieldName === "id") continue;

        if (fieldName in attrs) {
          const value = readField(model, fieldName);
          Reflect.set(updateData, fieldName, value instanceof Date ? value.toISOString() : value);
          hasUpdates = true;
          continue;
        }

        const linkAttr = links_[fieldName];
        if (!linkAttr) continue;
        const value = readField(model, fieldName);

        if (linkAttr.cardinality === "one") {
          const currentId = value instanceof Model ? value.id : null;
          const original = claim.data.relationships.get(fieldName);
          const originalId = typeof original === "string" ? original : null;
          if (currentId !== originalId) {
            if (originalId) {
              hasUnlinks = appendLink(unlinks, fieldName, originalId) || hasUnlinks;
            }
            if (currentId) {
              hasLinks = appendLink(links, fieldName, currentId) || hasLinks;
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
            if (!origSet.has(id)) {
              hasLinks = appendLink(links, fieldName, id) || hasLinks;
            }
          }
          for (const id of origSet) {
            if (!currSet.has(id)) {
              hasUnlinks = appendLink(unlinks, fieldName, id) || hasUnlinks;
            }
          }
        }
      }

      if (!hasUpdates && !hasLinks && !hasUnlinks) {
        return null;
      }

      let tx = txFor(model);
      if (hasUpdates) {
        tx = tx.update(updateData);
      }
      if (hasLinks) {
        tx = tx.link(links);
      }
      if (hasUnlinks) {
        tx = tx.unlink(unlinks);
      }
      return tx;
    };

    const buildTxChunkFromDiff = (
      model: Model,
      diff: ModelSnapshotDiff
    ): SchemaChunk<Schema> => {
      let tx = txFor(model);

      if (diff.scalars.size > 0) {
        const updateData: UpdateParams<Schema, keyof Schema["entities"] & string> = {};
        for (const [field, value] of diff.scalars) {
          Reflect.set(updateData, field, value instanceof Date ? value.toISOString() : value);
        }
        tx = tx.update(updateData);
      }

      for (const [fieldName, ids] of diff.links) {
        const linkData: LinkParams<Schema, keyof Schema["entities"] & string> = {};
        Reflect.set(linkData, fieldName, ids.length === 1 ? ids[0] : ids);
        tx = tx.link(linkData);
      }

      for (const [fieldName, ids] of diff.unlinks) {
        const unlinkData: LinkParams<Schema, keyof Schema["entities"] & string> = {};
        Reflect.set(unlinkData, fieldName, ids.length === 1 ? ids[0] : ids);
        tx = tx.unlink(unlinkData);
      }

      return tx;
    };

    const diffNew = (model: Model): ModelSnapshotDiff =>
      new ModelSnapshotDiff(
        ModelSnapshot.emptyOriginal(),
        new ModelSnapshot(model),
        model.entityName,
        true
      );

    this.claim = (model: Model, fieldName: string): void => {
      assertActive();
      if (newModels.has(model)) return;

      let record = claimedModels.get(model);
      if (!record) {
        record = { data: new ModelSnapshot(model), touched: new Set() };
        claimedModels.set(model, record);
        if (!model._activeClaims) model._activeClaims = new Set();
        model._activeClaims.add(record);
      }
      record.touched.add(fieldName);
    };

    this.registerNew = (model: Model): void => {
      assertActive();
      if (newModels.has(model)) return;
      newModels.add(model);

      const identityMap = store.getIdentityMapByName(model.entityName);
      if (!identityMap.has(model.id)) {
        identityMap.set(model);
      }
    };

    this.has = (model: Model): boolean =>
      claimedModels.has(model) || newModels.has(model);

    this.run = <T>(fn: () => T): T => {
      assertActive();
      return TransactionContext.run(this, fn);
    };

    this.commit = async (): Promise<void> => {
      assertActive();
      try {
        const chunks = TransactionContext.run(this, () => {
          const built: SchemaChunk<Schema>[] = [];
          for (const [model, claim] of claimedModels) {
            if (claim.touched.size === 0) continue;
            model.setUpdatedAt();
            const chunk = buildChunkFromTouched(model, claim);
            if (chunk) built.push(chunk);
          }
          for (const model of newModels) {
            // Bump updatedAt BEFORE snapshotting so the diff carries the
            // bumped timestamp out to the DB.
            model.setUpdatedAt();
            const diff = diffNew(model);
            if (!diff.hasChanges()) continue;
            built.push(buildTxChunkFromDiff(model, diff));
          }
          return built;
        });

        if (chunks.length > 0) {
          await store.db.transact(chunks);
        }
      } finally {
        releaseAll();
      }
    };

    this.rollback = (): void => {
      assertActive();
      try {
        runInAction(() => {
          for (const [model, claim] of claimedModels) {
            restoreTouchedFields(model, claim);
          }
          for (const model of newModels) {
            const identityMap = store.getIdentityMapByName(model.entityName);
            identityMap.delete(model.id);
            model.disposeTracking();
          }
        });
      } finally {
        releaseAll();
      }
    };

    this.dispose = (): void => {
      if (!finalized) {
        releaseAll();
      }
    };
  }
}
