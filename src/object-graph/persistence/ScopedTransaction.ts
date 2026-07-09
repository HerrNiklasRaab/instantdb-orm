import { runInAction } from "mobx";
import type { LinkParams, TransactionChunk, TxChunk, UpdateParams } from "@instantdb/core";
import type { AnySchema } from "../../instantdb";
import { Model, isModel } from "../Model";
import { ModelSnapshot } from "./ModelSnapshot";
import { ModelSnapshotDiff } from "./ModelSnapshotDiff";
import { TransactionContext } from "./TransactionContext";
import { getEntityAttrs, getEntityLinks, readField } from "../store/EntityMeta";
import { fieldsForModel } from "../store/fieldsForEntity";

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
  evictModel(model: Model): void;
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

interface NewModelRecord {
  readonly data: ModelSnapshot;
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
  readonly adopt: (model: Model) => void;
  readonly deleteModel: (model: Model) => void;
  readonly has: (model: Model) => boolean;
  readonly run: <T>(fn: () => T) => T;
  readonly commit: () => Promise<void>;
  readonly rollback: () => void;
  readonly dispose: () => void;

  constructor(store: TransactionStoreAccess<Schema>) {
    const claimedModels = new Map<Model, ClaimRecord>();
    const newModels = new Map<Model, NewModelRecord>();
    const deletedModels = new Set<Model>();
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
      deletedModels.clear();
      finalized = true;
    };

    const relatedModelsFor = (model: Model): Model[] => {
      const result: Model[] = [];
      for (const [fieldName, linkAttr] of Object.entries(getEntityLinks(model.entityName))) {
        const value = readField(model, fieldName);
        if (linkAttr.cardinality === "one") {
          if (isModel(value)) result.push(value);
        } else if (Array.isArray(value)) {
          for (const item of value) {
            if (isModel(item)) result.push(item);
          }
        }
      }
      return result;
    };

    const registerNewGraph = (model: Model, visited: Set<Model>): void => {
      assertActive();
      if (visited.has(model)) return;
      visited.add(model);
      if (!newModels.has(model)) {
        if (!model._adoptAsPendingNew()) return;
        newModels.set(model, { data: new ModelSnapshot(model) });

        const identityMap = store.getIdentityMapByName(model.entityName);
        if (!identityMap.has(model.id)) {
          identityMap.set(model);
        }
      }
      if (!newModels.has(model)) return;
      for (const relatedModel of relatedModelsFor(model)) {
        registerNewGraph(relatedModel, visited);
      }
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

    const expandTouchedToColumns = (model: Model, touched: Set<string>): Set<string> => {
      // Touched keys are attributeNames (see Model.setupObservers); expand each
      // to its owned columns (a composed field spans several; a plain field is
      // its single column).
      const columnsByAttr = new Map<string, string[]>();
      for (const field of fieldsForModel(model.constructor, model.entityName)) {
        columnsByAttr.set(field.attributeName, field.ownedColumns(""));
      }
      const expanded = new Set<string>();
      for (const attr of touched) {
        const columns = columnsByAttr.get(attr);
        if (columns) {
          for (const col of columns) expanded.add(col);
        } else {
          expanded.add(attr);
        }
      }
      return expanded;
    };

    const touchedFieldsHaveChanges = (model: Model, claim: ClaimRecord): boolean => {
      const entityName = model.entityName;
      const currentSnapshot = new ModelSnapshot(model);
      const diff = new ModelSnapshotDiff(claim.data, currentSnapshot, entityName, false);
      const expandedColumns = expandTouchedToColumns(model, claim.touched);
      for (const columnName of diff.scalars.keys()) {
        if (expandedColumns.has(columnName)) return true;
      }
      const links_ = getEntityLinks(entityName);
      for (const fieldName of claim.touched) {
        if (!(fieldName in links_)) continue;
        if (diff.links.has(fieldName) || diff.unlinks.has(fieldName)) return true;
      }
      return false;
    };

    const buildChunkFromTouched = (
      model: Model,
      claim: ClaimRecord
    ): SchemaChunk<Schema> | null => {
      const entityName = model.entityName;
      const attrs = getEntityAttrs(entityName);
      const links_ = getEntityLinks(entityName);
      const currentSnapshot = new ModelSnapshot(model);
      const diff = new ModelSnapshotDiff(claim.data, currentSnapshot, entityName, false);
      const expandedColumns = expandTouchedToColumns(model, claim.touched);

      const updateData: UpdateParams<Schema, keyof Schema["entities"] & string> = {};
      const links: LinkParams<Schema, keyof Schema["entities"] & string> = {};
      const unlinks: LinkParams<Schema, keyof Schema["entities"] & string> = {};
      let hasUpdates = false;
      let hasLinks = false;
      let hasUnlinks = false;

      for (const [columnName, value] of diff.scalars) {
        if (columnName === "id") continue;
        if (!expandedColumns.has(columnName)) continue;
        Reflect.set(updateData, columnName, value);
        hasUpdates = true;
      }

      for (const fieldName of claim.touched) {
        if (fieldName === "id") continue;
        if (fieldName in attrs) continue;

        const linkAttr = links_[fieldName];
        if (!linkAttr) continue;
        const value = readField(model, fieldName);

        if (linkAttr.cardinality === "one") {
          const currentId = isModel(value) ? value.id : null;
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
              if (isModel(item)) currentIds.push(item.id);
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

    const buildSoftDeleteChunk = (model: Model): SchemaChunk<Schema> | null => {
      model.setUpdatedAt();
      const snapshot = new ModelSnapshot(model);
      const deletedAt = snapshot.scalars.get("deletedAt");
      if (deletedAt === null || deletedAt === undefined) return null;

      const updateData: UpdateParams<Schema, keyof Schema["entities"] & string> = {};
      Reflect.set(updateData, "deletedAt", deletedAt);
      const updatedAt = snapshot.scalars.get("updatedAt");
      if (updatedAt !== undefined) {
        Reflect.set(updateData, "updatedAt", updatedAt);
      }
      return txFor(model).update(updateData);
    };

    const buildPhysicalDeleteChunk = (model: Model): SchemaChunk<Schema> =>
      txFor(model).delete();

    const buildTxChunkFromDiff = (
      model: Model,
      diff: ModelSnapshotDiff
    ): SchemaChunk<Schema> => {
      let tx = txFor(model);

      if (diff.scalars.size > 0) {
        const updateData: UpdateParams<Schema, keyof Schema["entities"] & string> = {};
        for (const [field, value] of diff.scalars) {
          Reflect.set(updateData, field, value);
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
      registerNewGraph(model, new Set());
    };

    this.adopt = (model: Model): void => {
      registerNewGraph(model, new Set());
    };

    this.deleteModel = (model: Model): void => {
      assertActive();
      if (newModels.has(model)) {
        throw new Error(`Cannot delete new ${model.entityName} ${model.id}.`);
      }
      deletedModels.add(model);
    };

    this.has = (model: Model): boolean =>
      claimedModels.has(model) || newModels.has(model) || deletedModels.has(model);

    this.run = <T>(fn: () => T): T => {
      assertActive();
      return TransactionContext.run(this, fn);
    };

    this.commit = async (): Promise<void> => {
      assertActive();
      let firstCommitSucceeded = false;
      try {
        const chunks = TransactionContext.run(this, () => {
          const built: SchemaChunk<Schema>[] = [];
          for (const [model, claim] of claimedModels) {
            if (deletedModels.has(model)) continue;
            if (claim.touched.size === 0) continue;
            if (!touchedFieldsHaveChanges(model, claim)) continue;
            model.setUpdatedAt();
            const chunk = buildChunkFromTouched(model, claim);
            if (chunk) built.push(chunk);
          }
          for (const model of newModels.keys()) {
            // Bump updatedAt BEFORE snapshotting so the diff carries the
            // bumped timestamp out to the DB.
            model.setUpdatedAt();
            const diff = diffNew(model);
            if (!diff.hasChanges()) continue;
            built.push(buildTxChunkFromDiff(model, diff));
          }
          for (const model of deletedModels) {
            const chunk = buildSoftDeleteChunk(model);
            if (chunk) built.push(chunk);
          }
          return built;
        });

        if (chunks.length > 0) {
          await store.db.transact(chunks);
        }
        firstCommitSucceeded = true;
        for (const model of newModels.keys()) {
          model._persistPendingNew();
        }
        if (deletedModels.size > 0) {
          for (const model of deletedModels) {
            store.evictModel(model);
          }
          await store.db.transact([...deletedModels].map(buildPhysicalDeleteChunk));
          for (const model of deletedModels) {
            model._markHardDeleted();
          }
        }
      } catch (error) {
        if (!firstCommitSucceeded) {
          for (const model of newModels.keys()) {
            const identityMap = store.getIdentityMapByName(model.entityName);
            identityMap.delete(model.id);
            model._discardPendingNew();
          }
        }
        throw error;
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
          for (const [model, record] of newModels) {
            store.rehydrateModel(model, record.data.toRawEntityData(model.id));
          }
          for (const model of newModels.keys()) {
            const identityMap = store.getIdentityMapByName(model.entityName);
            identityMap.delete(model.id);
            model._discardPendingNew();
          }
        });
      } finally {
        releaseAll();
      }
    };

    this.dispose = (): void => {
      if (!finalized) {
        for (const model of newModels.keys()) {
          const identityMap = store.getIdentityMapByName(model.entityName);
          identityMap.delete(model.id);
          model._discardPendingNew();
        }
        releaseAll();
      }
    };
  }
}
