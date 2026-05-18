import { runInAction } from "mobx";
import type { IdentityMap } from "../IdentityMap";
import { Model } from "../Model";
import {
  getModelClass,
  getModelClassForDiscriminator,
  hasDiscriminatorMapping,
} from "./ModelRegistry";
import type { EntityName } from "./EntityMeta";
import type { ModelInstanceFor } from "./types";
import { getEntityMeta } from "./EntityMeta";
import type { RawEntityData } from "./types";
import { RootStore } from "./RootStore";
import { withHydration } from "./hydrationContext";

export type GetIdentityMap = <K extends EntityName>(
  entityName: K
) => IdentityMap<ModelInstanceFor<K>>;

export class ModelHydrator {
  constructor(private store: RootStore) { }

  hydrate<K extends EntityName>(
    entityName: K,
    rawData: RawEntityData,
    getIdentityMap: GetIdentityMap
  ): ModelInstanceFor<K> | null {
    return withHydration(() =>
      this.hydrateUnguarded(entityName, rawData, getIdentityMap)
    );
  }

  private hydrateUnguarded<K extends EntityName>(
    entityName: K,
    rawData: RawEntityData,
    getIdentityMap: GetIdentityMap
  ): ModelInstanceFor<K> | null {
    const ModelClass = this.resolveModelClass(entityName, rawData);
    const identityMap = getIdentityMap(entityName);
    const meta = getEntityMeta(entityName);

    const model = identityMap.getOrCreate(rawData.id, () => {
      const prototype: unknown = Reflect.get(ModelClass, "prototype");
      if (prototype === null || (typeof prototype !== "object" && typeof prototype !== "function")) {
        throw new Error(`Cannot hydrate ${entityName}: ModelClass has no prototype.`);
      }
      const blank: unknown = Object.create(prototype);
      if (!(blank instanceof Model)) {
        throw new Error(
          `Hydration produced a non-Model instance for entity '${entityName}'.`
        );
      }
      const instance: ModelInstanceFor<K> = blank;

      Reflect.set(instance, "id", rawData.id);

      for (const field of meta.scalarFields) {
        if (field.fieldName === "modelType") continue;
        field.write(instance, undefined);
      }

      for (const rel of meta.relationshipFields) {
        rel.write(instance, rel.isToMany() ? [] : null);
      }

      instance.initTracking(false);

      return instance;
    });

    this.updateModelFields(model, entityName, rawData, getIdentityMap);

    if (model.deletedAt != null) {
      this.store.cleanupRelationships(entityName, model);
      identityMap.delete(rawData.id);
      return null;
    }

    return model;
  }

  hydrateMany<K extends EntityName>(
    entityName: K,
    rawDataArray: RawEntityData[],
    getIdentityMap: GetIdentityMap
  ): ModelInstanceFor<K>[] {
    return runInAction(() =>
      rawDataArray
        .map((rawData) => this.hydrate(entityName, rawData, getIdentityMap))
        .filter((model): model is ModelInstanceFor<K> => model !== null)
    );
  }

  /**
   * Re-hydrate an existing model from raw data.
   * Used for rollback/restore operations.
   */
  rehydrate(
    model: Model,
    rawData: RawEntityData,
    getIdentityMap: GetIdentityMap
  ): void {
    withHydration(() =>
      { this.updateModelFields(model, model.entityName, rawData, getIdentityMap); }
    );
  }

  private updateModelFields(
    model: Model,
    entityName: EntityName,
    rawData: RawEntityData,
    getIdentityMap: GetIdentityMap
  ): void {
    const meta = getEntityMeta(entityName);

    runInAction(() => {
      for (const field of meta.scalarFields) {
        if (field.fieldName === "modelType") continue;
        // Skip fields the user has locally mutated in any active tx —
        // a remote update must not stomp an in-progress edit.
        if (model.isFieldTouched(field.fieldName)) continue;
        const value = rawData[field.fieldName];
        if (value !== undefined) {
          const next =
            field.isDate && value != null && (typeof value === "string" || typeof value === "number")
              ? new Date(value)
              : value;
          field.write(model, next);
        }
      }

      this.resolveRelationshipsFromNestedData(
        model,
        entityName,
        rawData,
        getIdentityMap
      );
    });
  }

  private resolveRelationshipsFromNestedData(
    model: Model,
    entityName: EntityName,
    rawData: RawEntityData,
    getIdentityMap: GetIdentityMap
  ): void {
    const meta = getEntityMeta(entityName);

    for (const rel of meta.relationshipFields) {
      const nestedData = rawData[rel.fieldName];

      // Skip if relationship data wasn't included in query (undefined)
      // But process null explicitly - it means "clear the relationship"
      if (nestedData === undefined) continue;
      // Skip if the user has locally mutated this relationship in any active tx.
      if (model.isFieldTouched(rel.fieldName)) continue;

      const nestedArray: unknown[] = Array.isArray(nestedData)
        ? nestedData
        : [nestedData];

      const targetMap = getIdentityMap(rel.targetEntity);

      if (rel.isToOne()) {
        const firstItem = toRawEntityData(nestedArray[0]);
        if (firstItem?.id) {
          let targetModel: Model | null = null;
          if (this.hasFullEntityData(firstItem)) {
            targetModel = this.hydrate(rel.targetEntity, firstItem, getIdentityMap);
          } else {
            targetModel = targetMap.get(firstItem.id) ?? null;
          }

          if (targetModel) {
            rel.write(model, targetModel);
            this.setReverseRelationship(model, targetModel, rel);
          }
        } else {
          rel.write(model, null);
        }
      } else {
        const existing = rel.read(model);
        if (!Array.isArray(existing)) continue;
        existing.length = 0;

        for (const rawItem of nestedArray) {
          const item = toRawEntityData(rawItem);
          if (!item) continue;
          let targetModel: Model | null = null;
          if (this.hasFullEntityData(item)) {
            targetModel = this.hydrate(rel.targetEntity, item, getIdentityMap);
          } else {
            targetModel = targetMap.get(item.id) ?? null;
          }

          if (targetModel) {
            existing.push(targetModel);
            this.setReverseRelationship(model, targetModel, rel);
          }
        }
      }
    }
  }

  /**
   * Check if raw data contains more than just an id field,
   * indicating it's full entity data that should be hydrated.
   */
  private hasFullEntityData(rawData: RawEntityData): boolean {
    const keys = Object.keys(rawData);
    return keys.length > 1 || (keys.length === 1 && keys[0] !== "id");
  }

  /**
   * Resolves the concrete model class to instantiate.
   * For STI entities, uses 'modelType' discriminator to find the correct subclass.
   */
  private resolveModelClass(
    entityName: string,
    rawData: RawEntityData
  ): ReturnType<typeof getModelClass> {
    if (hasDiscriminatorMapping(entityName)) {
      const rawDiscriminator = rawData.modelType;
      const discriminatorValue =
        typeof rawDiscriminator === "string" ? rawDiscriminator : undefined;

      if (!discriminatorValue) {
        throw new Error(
          `Entity '${entityName}' uses STI but record ${rawData.id} has no 'modelType' field.`
        );
      }

      const SubClass = getModelClassForDiscriminator(
        entityName,
        discriminatorValue
      );
      if (!SubClass) {
        throw new Error(
          `Unknown discriminator '${discriminatorValue}' for entity '${entityName}'. ` +
          `Did you register a @model class with 'get modelType() { return "${discriminatorValue}"; }'?`
        );
      }

      return SubClass;
    }

    return getModelClass(entityName);
  }

  private setReverseRelationship(
    model: Model,
    targetModel: Model,
    rel: { fieldName: string; targetEntity: EntityName; cardinality: "one" | "many"; isForward: boolean; linkName: string }
  ): void {
    const targetMeta = getEntityMeta(rel.targetEntity);
    const reverseRel = targetMeta.findReverseRelationship(rel.linkName, rel.fieldName);

    if (!reverseRel) return;

    if (reverseRel.isToMany()) {
      const array = reverseRel.read(targetModel);
      if (Array.isArray(array)) {
        array.push(model);
      }
    } else {
      reverseRel.write(targetModel, model);
    }
  }
}

function toRawEntityData(value: unknown): RawEntityData | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const id: unknown = Reflect.get(value, "id");
  if (typeof id !== "string") return undefined;
  const record: RawEntityData = { id };
  for (const key of Object.keys(value)) {
    if (key === "id") continue;
    record[key] = Reflect.get(value, key);
  }
  return record;
}
