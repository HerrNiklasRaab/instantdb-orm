import { runInAction } from "mobx";
import type { AnySchema } from "../../instantdb";
import type { IdentityMap } from "../IdentityMap";
import { Model, ModelLifecycle } from "../Model";
import {
  getModelClass,
  getModelClassForDiscriminator,
  hasDiscriminatorMapping,
} from "./ModelRegistry";
import type { EntityName } from "./EntityMeta";
import type { ModelInstanceFor } from "./types";
import { findReverseSide, getEntityLinks, readField, writeField } from "./EntityMeta";
import type { RawEntityData } from "./types";
import { RootStore } from "./RootStore";
import { withHydration } from "./hydrationContext";
import { fieldsForModel } from "./fieldsForEntity";

export type GetIdentityMap = <K extends EntityName>(
  entityName: K
) => IdentityMap<ModelInstanceFor<K>>;

// Build a blank instance of the registry's class for `entityName`, narrowed to
// its model type. Identity is verified against the exact class prototype, not
// `instanceof Model`: across duplicate bundle copies the two `Model` classes
// aren't ===, so an `instanceof` check would wrongly fail. See globalState.ts
// for why copies exist.
function createBlankInstance<K extends EntityName>(
  ModelClass: ReturnType<typeof getModelClass>,
  entityName: K
): ModelInstanceFor<K> {
  const proto: object = ModelClass.prototype;
  const blank: unknown = Object.create(proto);
  if (!hasExactPrototype<K>(blank, proto)) {
    throw new Error(
      `Hydration produced a non-Model instance for entity '${entityName}'.`
    );
  }
  return blank;
}

function hasExactPrototype<K extends EntityName>(
  value: unknown,
  proto: object
): value is ModelInstanceFor<K> {
  return value !== null && typeof value === "object" && Reflect.getPrototypeOf(value) === proto;
}

export class ModelHydrator<Schema extends AnySchema> {
  constructor(private store: RootStore<Schema>) { }

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
    const links = getEntityLinks(entityName);

    const model = identityMap.getOrCreate(rawData.id, () => {
      const instance = createBlankInstance<K>(ModelClass, entityName);

      Reflect.set(instance, "id", rawData.id);

      // Seed each column-field so the property exists before makeObservable
      // (MobX throws on annotated-but-absent fields). undefined is the uniform
      // "not returned" sentinel; present columns overwrite it in updateModelFields
      // (a present-but-empty column becomes null via the codec's assemble).
      for (const field of fieldsForModel(ModelClass, entityName)) {
        Reflect.set(instance, field.propertyName, undefined);
      }

      for (const [fieldName, linkAttr] of Object.entries(links)) {
        writeField(instance, fieldName, linkAttr.cardinality === "many" ? [] : null);
      }

      instance.initTracking(ModelLifecycle.Persisted);

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
    runInAction(() => {
      // Every column flows through a Field+codec — composed fields (VO/Temporal)
      // use their declared codec; un-annotated columns get a default codec by
      // valueType (date → Temporal.Instant, else passthrough). No raw path.
      for (const field of fieldsForModel(model.constructor, entityName)) {
        if (model.isFieldTouched(field.attributeName)) continue;
        let anyPresent = false;
        for (const col of field.ownedColumns("")) {
          if (rawData[col] !== undefined) { anyPresent = true; break; }
        }
        if (!anyPresent) continue;
        field.hydrateFromColumns(
          model,
          (column) => rawData[column] ?? null,
          (column) => rawData[column] !== undefined
        );
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
    for (const [fieldName, linkAttr] of Object.entries(getEntityLinks(entityName))) {
      const nestedData = rawData[fieldName];

      if (nestedData === undefined) continue;
      if (model.isFieldTouched(fieldName)) continue;

      const nestedArray: unknown[] = Array.isArray(nestedData)
        ? nestedData
        : [nestedData];

      const targetEntity = linkAttr.entityName;
      const targetMap = getIdentityMap(targetEntity);

      if (linkAttr.cardinality === "one") {
        const firstItem = toRawEntityData(nestedArray[0]);
        if (firstItem?.id) {
          let targetModel: Model | null = null;
          if (this.hasFullEntityData(firstItem)) {
            targetModel = this.hydrate(targetEntity, firstItem, getIdentityMap);
          } else {
            targetModel = targetMap.get(firstItem.id) ?? null;
          }

          if (targetModel) {
            writeField(model, fieldName, targetModel);
            this.setReverseRelationship(model, targetModel, fieldName);
          }
        } else {
          writeField(model, fieldName, null);
        }
      } else {
        const existing = readField(model, fieldName);
        if (!Array.isArray(existing)) continue;
        existing.length = 0;

        for (const rawItem of nestedArray) {
          const item = toRawEntityData(rawItem);
          if (!item) continue;
          let targetModel: Model | null = null;
          if (this.hasFullEntityData(item)) {
            targetModel = this.hydrate(targetEntity, item, getIdentityMap);
          } else {
            targetModel = targetMap.get(item.id) ?? null;
          }

          if (targetModel) {
            existing.push(targetModel);
            this.setReverseRelationship(model, targetModel, fieldName);
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
    fieldName: string
  ): void {
    const reverse = findReverseSide(model.entityName, fieldName);
    if (!reverse) return;
    const [, reverseFieldName, reverseCardinality] = reverse;

    if (reverseCardinality === "many") {
      const array = readField(targetModel, reverseFieldName);
      if (Array.isArray(array)) {
        array.push(model);
      }
    } else {
      writeField(targetModel, reverseFieldName, model);
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
