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
import { getEntityMeta, getPropertyName } from "./EntityMeta";
import type { RawEntityData } from "./types";
import { RootStore } from "./RootStore";

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
    const ModelClass = this.resolveModelClass(entityName, rawData);
    const identityMap = getIdentityMap(entityName);
    const meta = getEntityMeta(entityName);

    const model = identityMap.getOrCreate(rawData.id, () => {
      // Build data object with all scalar fields (order-independent)
      const dataArg: Record<string, unknown> = {};
      for (const field of meta.scalarFields) {
        if (field === "id") continue;
        const value = rawData[field];
        if (value !== undefined) {
          dataArg[field] = meta.isDateField(field) && value != null
            ? new Date(value as string | number)
            : value;
        }
      }
      return Reflect.construct(ModelClass, [rawData.id, dataArg]) as ModelInstanceFor<K>;
    });

    this.updateModelFields(model, entityName, rawData, getIdentityMap);

    // Mark model as not new and clear dirty state (it exists in database)
    model._tracker!.reset();

    // Check if model is soft-deleted
    if (model.deletedAt != null) {
      // Clean up relationships and remove from identity map
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
    return rawDataArray
      .map((rawData) => this.hydrate(entityName, rawData, getIdentityMap))
      .filter((model): model is ModelInstanceFor<K> => model !== null);
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
      // Update ALL scalar fields from raw data (handles re-hydration of existing models)
      // Use private backing field if exists (e.g., _name for schema field "name")
      for (const field of meta.scalarFields) {
        if (field === "id" || field === "type") continue; // Don't update id or type discriminator
        const value = rawData[field];
        if (value !== undefined) {
          const propName = getPropertyName(model, field);
          record[propName] = meta.isDateField(field) && value != null
            ? new Date(value as string | number)
            : value;
        }
      }

      // Resolve relationships from nested data
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

      // Skip if no nested relationship data
      if (!nestedData) continue;

      // Normalize nested data to array format
      // InstantDB returns arrays for simple queries, but objects for deeply nested queries
      const nestedArray = Array.isArray(nestedData)
        ? nestedData
        : [nestedData];

      const targetMap = getIdentityMap(rel.targetEntity);

      // Use private backing field if exists
      const propName = getPropertyName(model, rel.fieldName);

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

            if (targetModel && !existingArray.includes(targetModel)) {
              existingArray.push(targetModel);

              // Set up bidirectional relationship
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
   * For STI entities, uses 'type' discriminator to find the correct subclass.
   */
  private resolveModelClass(
    entityName: string,
    rawData: RawEntityData
  ): ReturnType<typeof getModelClass> {
    if (hasDiscriminatorMapping(entityName)) {
      const discriminatorValue = rawData.type as string | undefined;

      if (!discriminatorValue) {
        throw new Error(
          `Entity '${entityName}' uses STI but record ${rawData.id} has no 'type' field.`
        );
      }

      const SubClass = getModelClassForDiscriminator(
        entityName,
        discriminatorValue
      );
      if (!SubClass) {
        throw new Error(
          `Unknown discriminator '${discriminatorValue}' for entity '${entityName}'. ` +
            `Did you register a @model class with 'readonly type = "${discriminatorValue}"'?`
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
    // Use private backing field if exists
    const propName = getPropertyName(targetModel, reverseRel.fieldName);

    if (reverseRel.isToMany()) {
      const array = targetRecord[propName] as Model[];
      if (Array.isArray(array) && !array.includes(model)) {
        array.push(model);
      }
    } else {
      targetRecord[propName] = model;
    }
  }
}
