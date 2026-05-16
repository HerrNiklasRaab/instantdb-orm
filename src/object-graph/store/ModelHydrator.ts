import { runInAction } from "mobx";
import type { IdentityMap } from "../IdentityMap";
import type { Model } from "../Model";
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
      // Create instance without calling constructor (bypasses validation/business logic)
      const instance = Object.create(ModelClass.prototype) as ModelInstanceFor<K>;

      // Initialize ALL fields (field initializers don't run with Object.create)
      // MobX requires properties to exist on the object before makeObservable() is called

      // Set id directly - it's not in meta.scalarFields (InstantDB manages it implicitly)
      (instance as any).id = rawData.id;

      // Initialize scalar fields with undefined (will be overwritten by updateModelFields)
      // Using undefined (not null) so permission-restricted fields stay undefined if not in rawData
      for (const field of meta.scalarFields) {
        // Skip modelType (STI discriminator is a getter, not a settable field)
        if (field.fieldName === "modelType") continue;
        const propName = field.getFieldNameOnModel(instance);
        (instance as any)[propName] = undefined;
      }

      // Initialize relationship fields
      for (const rel of meta.relationshipFields) {
        const propName = rel.getFieldNameOnModel(instance);
        (instance as any)[propName] = rel.isToMany() ? [] : null;
      }

      // Set up observables now that all fields exist
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
      this.updateModelFields(model, model.entityName as EntityName, rawData, getIdentityMap)
    );
  }

  private updateModelFields(
    model: Model,
    entityName: EntityName,
    rawData: RawEntityData,
    getIdentityMap: GetIdentityMap
  ): void {
    const record = model as unknown as Record<string, unknown>;
    const meta = getEntityMeta(entityName);

    runInAction(() => {
      for (const field of meta.scalarFields) {
        if (field.fieldName === "modelType") continue;
        // Skip fields the user has locally mutated in any active tx —
        // a remote update must not stomp an in-progress edit.
        if (model.isFieldTouched(field.fieldName)) continue;
        const value = rawData[field.fieldName];
        if (value !== undefined) {
          const propName = field.getFieldNameOnModel(model);
          record[propName] = field.isDate && value != null
            ? new Date(value as string | number)
            : value;
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
    const record = model as unknown as Record<string, unknown>;

    for (const rel of meta.relationshipFields) {
      const nestedData = rawData[rel.fieldName];

      // Skip if relationship data wasn't included in query (undefined)
      // But process null explicitly - it means "clear the relationship"
      if (nestedData === undefined) continue;
      // Skip if the user has locally mutated this relationship in any active tx.
      if (model.isFieldTouched(rel.fieldName)) continue;

      // Normalize nested data to array format
      // InstantDB returns arrays for simple queries, but objects for deeply nested queries
      const nestedArray = Array.isArray(nestedData)
        ? nestedData
        : [nestedData];

      const targetMap = getIdentityMap(rel.targetEntity);
      const propName = rel.getFieldNameOnModel(model);

      if (rel.isToOne()) {
        // has-one: InstantDB returns [{ id: '...' }] or { id: '...' } for has-one relationships
        const firstItem = nestedArray[0] as RawEntityData | undefined;
        if (firstItem?.id) {
          // Full data → hydrate, ID only (circular refs) → lookup in identity map
          let targetModel: Model | null = null;
          if (this.hasFullEntityData(firstItem)) {
            targetModel = this.hydrate(rel.targetEntity, firstItem, getIdentityMap);
          } else {
            targetModel = targetMap.get(firstItem.id) ?? null;
          }

          if (targetModel) {
            record[propName] = targetModel;

            // Set up bidirectional relationship
            this.setReverseRelationship(model, targetModel, rel);
          }
        } else {
          // Empty array means no relationship - set to null
          record[propName] = null;
        }
      } else {
        // has-many: Clear and rebuild the array
        const existingArray = record[propName] as Model[];
        if (Array.isArray(existingArray)) {
          existingArray.length = 0; // Clear existing

          for (const item of nestedArray as RawEntityData[]) {
            // Full data → hydrate, ID only (circular refs) → lookup in identity map
            let targetModel: Model | null = null;
            if (this.hasFullEntityData(item)) {
              targetModel = this.hydrate(rel.targetEntity, item, getIdentityMap);
            } else {
              targetModel = targetMap.get(item.id) ?? null;
            }

            if (targetModel) {
              existingArray.push(targetModel);
              this.setReverseRelationship(model, targetModel, rel);
            }
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
      const discriminatorValue = rawData.modelType as string | undefined;

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
    // Find the reverse relationship on the target model
    const targetMeta = getEntityMeta(rel.targetEntity);
    const reverseRel = targetMeta.findReverseRelationship(rel.linkName, rel.fieldName);

    if (!reverseRel) return;

    const targetRecord = targetModel as unknown as Record<string, unknown>;
    const propName = reverseRel.getFieldNameOnModel(targetModel);

    if (reverseRel.isToMany()) {
      const array = targetRecord[propName] as Model[];
      if (Array.isArray(array)) {
        array.push(model);
      }
    } else {
      targetRecord[propName] = model;
    }
  }
}
