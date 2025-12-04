import { runInAction } from "mobx";
import type { IdentityMap } from "../IdentityMap";
import type { Model } from "../Model";
import {
  getEntityClass,
  type EntityName,
  type EntityInstanceFor,
} from "./EntityRegistry";
import { getEntityMeta, getPropertyName } from "./EntityMeta";
import type { RawEntityData } from "./types";
import { RootStore } from "./RootStore";

export type GetIdentityMap = <K extends EntityName>(
  entityName: K
) => IdentityMap<EntityInstanceFor<K>>;

export class EntityHydrator {
  constructor(private store: RootStore) { }

  hydrate<K extends EntityName>(
    entityName: K,
    rawData: RawEntityData,
    getIdentityMap: GetIdentityMap
  ): EntityInstanceFor<K> | null {
    const EntityClass = getEntityClass(entityName);
    const identityMap = getIdentityMap(entityName);
    const meta = getEntityMeta(entityName);

    const entity = identityMap.getOrCreate(rawData.id, () => {
      // Build constructor args: id + required fields in schema order
      const args = [
        rawData.id,
        ...meta.requiredFields.map((field) => {
          const value = rawData[field];
          return meta.isDateField(field) && value != null
            ? new Date(value as string | number)
            : value;
        }),
      ];
      return Reflect.construct(EntityClass, args) as EntityInstanceFor<K>;
    });

    this.updateEntityFields(entity, entityName, rawData, getIdentityMap);

    // Mark entity as not new and clear dirty state (it exists in database)
    entity._tracker.reset();

    // Check if entity is soft-deleted
    if (entity.deletedAt != null) {
      // Clean up relationships and remove from identity map
      this.store.cleanupRelationships(entityName, entity);
      identityMap.delete(rawData.id);
      return null;
    }

    return entity;
  }

  hydrateMany<K extends EntityName>(
    entityName: K,
    rawDataArray: RawEntityData[],
    getIdentityMap: GetIdentityMap
  ): EntityInstanceFor<K>[] {
    return rawDataArray
      .map((rawData) => this.hydrate(entityName, rawData, getIdentityMap))
      .filter((entity): entity is EntityInstanceFor<K> => entity !== null);
  }

  private updateEntityFields(
    entity: Model,
    entityName: EntityName,
    rawData: RawEntityData,
    getIdentityMap: GetIdentityMap
  ): void {
    const record = entity as unknown as Record<string, unknown>;
    const meta = getEntityMeta(entityName);

    runInAction(() => {
      // Update ALL scalar fields from raw data (handles re-hydration of existing entities)
      // Use private backing field if exists (e.g., _name for schema field "name")
      for (const field of meta.scalarFields) {
        if (field === "id") continue; // Don't update id
        const value = rawData[field];
        if (value !== undefined) {
          const propName = getPropertyName(entity, field);
          record[propName] = meta.isDateField(field) && value != null
            ? new Date(value as string | number)
            : value;
        }
      }

      // Resolve relationships from nested data
      this.resolveRelationshipsFromNestedData(
        entity,
        entityName,
        rawData,
        getIdentityMap
      );
    });
  }

  private resolveRelationshipsFromNestedData(
    entity: Model,
    entityName: EntityName,
    rawData: RawEntityData,
    getIdentityMap: GetIdentityMap
  ): void {
    const meta = getEntityMeta(entityName);
    const record = entity as unknown as Record<string, unknown>;

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
      const propName = getPropertyName(entity, rel.fieldName);

      if (rel.isToOne()) {
        // has-one: InstantDB returns [{ id: '...' }] or { id: '...' } for has-one relationships
        const firstItem = nestedArray[0] as RawEntityData | undefined;
        if (firstItem?.id) {
          // If nested data has more than just id, recursively hydrate it first
          let targetEntity = targetMap.get(firstItem.id);
          if (!targetEntity && this.hasFullEntityData(firstItem)) {
            const hydrated = this.hydrate(
              rel.targetEntity,
              firstItem,
              getIdentityMap
            );
            // Skip if entity was deleted (hydrate returns null)
            if (hydrated) {
              targetEntity = hydrated;
            }
          }

          if (targetEntity) {
            record[propName] = targetEntity;

            // Set up bidirectional relationship
            this.setReverseRelationship(entity, targetEntity, rel);
          }
        }
      } else {
        // has-many: Clear and rebuild the array
        const existingArray = record[propName] as Model[];
        if (Array.isArray(existingArray)) {
          existingArray.length = 0; // Clear existing

          for (const item of nestedArray as RawEntityData[]) {
            // If nested data has more than just id, recursively hydrate it first
            let targetEntity = targetMap.get(item.id);
            if (!targetEntity && this.hasFullEntityData(item)) {
              const hydrated = this.hydrate(
                rel.targetEntity,
                item,
                getIdentityMap
              );
              // Skip if entity was deleted (hydrate returns null)
              if (hydrated) {
                targetEntity = hydrated;
              }
            }

            if (targetEntity && !existingArray.includes(targetEntity)) {
              existingArray.push(targetEntity);

              // Set up bidirectional relationship
              this.setReverseRelationship(entity, targetEntity, rel);
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

  private setReverseRelationship(
    entity: Model,
    targetEntity: Model,
    rel: { fieldName: string; targetEntity: EntityName; cardinality: "one" | "many"; isForward: boolean; linkName: string }
  ): void {
    // Find the reverse relationship on the target entity
    const targetMeta = getEntityMeta(rel.targetEntity);
    const reverseRel = targetMeta.findReverseRelationship(rel.linkName, rel.fieldName);

    if (!reverseRel) return;

    const targetRecord = targetEntity as unknown as Record<string, unknown>;
    // Use private backing field if exists
    const propName = getPropertyName(targetEntity, reverseRel.fieldName);

    if (reverseRel.isToMany()) {
      const array = targetRecord[propName] as Model[];
      if (Array.isArray(array) && !array.includes(entity)) {
        array.push(entity);
      }
    } else {
      targetRecord[propName] = entity;
    }
  }
}
