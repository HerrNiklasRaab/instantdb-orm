import type { ColumnValue } from "../columns/types";
import type { RawEntityData } from "../store/types";
import { runInAction } from "mobx";
import type { SyncClient } from "../../client";
import { Transaction } from "../../transactions";
import { Model, isModel } from "../Model";
import { ModelSnapshot } from "./ModelSnapshot";
import { ModelSnapshotDiff } from "./ModelSnapshotDiff";
import { TransactionContext } from "./TransactionContext";
import { TransactionDraft } from "./TransactionDraft";
import { getEntityAttrs, getEntityLinks, readField } from "../store/EntityMeta";
import { fieldsForModel } from "../store/fieldsForEntity";

export interface TransactionStoreAccess {
  readonly client: Pick<SyncClient, "submit" | "verdict">;
  getIdentityMapByName(entityName: string): {
    has(id: string): boolean;
    set(model: Model): void;
    delete(id: string): boolean;
  };
  rehydrateModel(model: Model, rawData: RawEntityData): void;
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

export class ScopedTransaction {
  readonly claim: (model: Model, fieldName: string) => void;
  readonly shield: (model: Model, fieldName: string) => void;
  readonly registerNew: (model: Model) => void;
  readonly adopt: (model: Model) => void;
  readonly deleteModel: (model: Model) => void;
  readonly has: (model: Model) => boolean;
  readonly run: <T>(fn: () => T) => T;
  /**
   * Applies the transaction locally and sends it; resolves with its id once
   * applied, or `null` when there was nothing to write. The verdict arrives
   * later, through the client.
   */
  readonly commit: () => Promise<string | null>;
  readonly rollback: () => void;
  readonly dispose: () => void;

  constructor(store: TransactionStoreAccess) {
    const claimedModels = new Map<Model, ClaimRecord>();
    const shieldedFields = new Map<Model, Set<string>>();
    const newModels = new Map<Model, NewModelRecord>();
    const deletedModels = new Set<Model>();
    let finalized = false;

    const assertActive = (): void => {
      if (finalized) {
        throw new Error("Transaction has already been finalized");
      }
    };

    const releaseShields = (): void => {
      for (const [model, fields] of shieldedFields) {
        for (const field of fields) {
          model._activeShields?.delete(field);
        }
        if (model._activeShields && model._activeShields.size === 0) {
          model._activeShields = null;
        }
      }
      shieldedFields.clear();
    };

    const releaseAll = (): void => {
      for (const [model, record] of claimedModels) {
        model._activeClaims?.delete(record);
        if (model._activeClaims && model._activeClaims.size === 0) {
          model._activeClaims = null;
        }
      }
      releaseShields();
      claimedModels.clear();
      newModels.clear();
      deletedModels.clear();
      finalized = true;
    };

    const relatedModelsFor = (model: Model): Model[] => {
      const result: Model[] = [];
      for (const [fieldName, linkAttr] of Object.entries(getEntityLinks(model.entityName))) {
        const value = readField(model, fieldName);
        if (!linkAttr.array) {
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
      const filtered: RawEntityData = { id: model.id };
      for (const fieldName of fields) {
        if (fieldName in fullRaw) {
          filtered[fieldName] = fullRaw[fieldName];
        }
      }
      store.rehydrateModel(model, filtered);
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

    const appendTouchedWrites = (
      model: Model,
      claim: ClaimRecord,
      batch: TransactionDraft
    ): void => {
      const entityName = model.entityName;
      const attrs = getEntityAttrs(entityName);
      const links_ = getEntityLinks(entityName);
      const currentSnapshot = new ModelSnapshot(model);
      const diff = new ModelSnapshotDiff(claim.data, currentSnapshot, entityName, false);
      const expandedColumns = expandTouchedToColumns(model, claim.touched);

      const updateData: Record<string, ColumnValue> = {};
      let hasUpdates = false;
      for (const [columnName, value] of diff.scalars) {
        if (columnName === "id") continue;
        if (!expandedColumns.has(columnName)) continue;
        updateData[columnName] = value;
        hasUpdates = true;
      }
      if (hasUpdates) batch.update(entityName, model.id, updateData);

      for (const fieldName of claim.touched) {
        if (fieldName === "id") continue;
        if (fieldName in attrs) continue;

        const linkAttr = links_[fieldName];
        if (!linkAttr) continue;
        const value = readField(model, fieldName);

        if (!linkAttr.array) {
          const currentId = isModel(value) ? value.id : null;
          const original = claim.data.relationships.get(fieldName);
          const originalId = typeof original === "string" ? original : null;
          if (currentId === originalId) continue;
          batch.relink(entityName, model.id, fieldName, currentId ? [currentId] : [], originalId ? [originalId] : []);
        } else {
          const currentIds = new Set<string>();
          if (Array.isArray(value)) {
            for (const item of value) {
              if (isModel(item)) currentIds.add(item.id);
            }
          }
          const original = claim.data.relationships.get(fieldName);
          const originalIds = new Set(Array.isArray(original) ? original : []);
          batch.relink(
            entityName,
            model.id,
            fieldName,
            [...currentIds].filter((id) => !originalIds.has(id)),
            [...originalIds].filter((id) => !currentIds.has(id)),
          );
        }
      }
    };

    const appendSoftDelete = (model: Model, batch: TransactionDraft): void => {
      model.setUpdatedAt();
      const snapshot = new ModelSnapshot(model);
      const deletedAt = snapshot.scalars.get("deletedAt");
      if (deletedAt === null || deletedAt === undefined) return;

      const updateData: Record<string, ColumnValue> = { deletedAt };
      const updatedAt = snapshot.scalars.get("updatedAt");
      if (updatedAt !== undefined) updateData.updatedAt = updatedAt;
      batch.update(model.entityName, model.id, updateData);
    };

    const appendCreate = (model: Model, diff: ModelSnapshotDiff, batch: TransactionDraft): void => {
      batch.create(model.entityName, model.id, Object.fromEntries(diff.scalars));
      for (const [fieldName, ids] of diff.links) {
        batch.relink(model.entityName, model.id, fieldName, ids, []);
      }
      for (const [fieldName, ids] of diff.unlinks) {
        batch.relink(model.entityName, model.id, fieldName, [], ids);
      }
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

    this.shield = (model: Model, fieldName: string): void => {
      assertActive();
      let fields = shieldedFields.get(model);
      if (!fields) {
        fields = new Set();
        shieldedFields.set(model, fields);
      }
      fields.add(fieldName);
      if (!model._activeShields) model._activeShields = new Set();
      model._activeShields.add(fieldName);
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

    // The row goes for good only once the server has accepted the soft
    // delete; if either never lands, the row stays soft-deleted.
    const hardDeleteOnceSoftDeleted = async (softDeleteId: string, models: Model[]): Promise<void> => {
      try {
        if (!(await isCommitted(softDeleteId))) return;
        const physicalDeletes = new Transaction();
        for (const model of models) physicalDeletes.delete(model.entityName, model.id);
        await store.client.submit(physicalDeletes);
        if (!(await isCommitted(physicalDeletes.id))) return;
        for (const model of models) model._markHardDeleted();
      } catch {
        // The client went away before answering; the row stays soft-deleted.
      }
    };

    const isCommitted = async (transactionId: string): Promise<boolean> =>
      (await store.client.verdict(transactionId)).status === "committed";

    // Nothing of a transaction that did not land exists anywhere else, so
    // the local models must not keep it either.
    const undoUnlanded = (): void => {
      releaseShields();
      runInAction(() => {
        for (const [model, claim] of claimedModels) {
          restoreTouchedFields(model, claim);
        }
        for (const model of newModels.keys()) {
          const identityMap = store.getIdentityMapByName(model.entityName);
          identityMap.delete(model.id);
          model._discardPendingNew();
        }
      });
    };

    this.commit = async (): Promise<string | null> => {
      assertActive();
      let submitted = false;
      try {
        const batch = TransactionContext.run(this, () => {
          const built = new TransactionDraft();
          for (const [model, claim] of claimedModels) {
            if (deletedModels.has(model)) continue;
            if (claim.touched.size === 0) continue;
            if (!touchedFieldsHaveChanges(model, claim)) continue;
            model.setUpdatedAt();
            appendTouchedWrites(model, claim, built);
          }
          for (const model of newModels.keys()) {
            // Bump updatedAt BEFORE snapshotting so the diff carries the
            // bumped timestamp out to the DB.
            model.setUpdatedAt();
            const diff = diffNew(model);
            if (!diff.hasChanges()) continue;
            appendCreate(model, diff, built);
          }
          for (const model of deletedModels) {
            appendSoftDelete(model, built);
          }
          return built.build();
        });

        // A denial arrives later, as an effect the store takes back.
        await store.client.submit(batch);
        submitted = true;
        for (const model of newModels.keys()) {
          model._persistPendingNew();
        }
        if (deletedModels.size > 0) {
          for (const model of deletedModels) {
            store.evictModel(model);
          }
          void hardDeleteOnceSoftDeleted(batch.id, [...deletedModels]);
        }
        return batch.isEmpty ? null : batch.id;
      } catch (error) {
        if (!submitted) undoUnlanded();
        throw error;
      } finally {
        releaseAll();
      }
    };

    this.rollback = (): void => {
      assertActive();
      try {
        // Restoration rehydrates through the hydrator, which skips shielded
        // fields — and a rolled-back transaction's link state is void anyway.
        releaseShields();
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
