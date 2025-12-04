import { runInAction } from "mobx";
import type { IdentityMap } from "../IdentityMap";
import type { Model } from "../Model";
import {
  getEntityClass,
  type EntityName,
  type EntityInstanceFor,
} from "./EntityRegistry";
import { getEntityMeta } from "./EntityMeta";
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

    const entity = identityMap.getOrCreate(rawData.id, () => {
      return new EntityClass(rawData.id, this.store) as EntityInstanceFor<K>;
    });

    this.updateEntityFields(entity, entityName, rawData, getIdentityMap);

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
    const relationshipFieldNames = meta.getRelationshipFieldNames();

    runInAction(() => {
      // First pass: hydrate scalar fields
      for (const [key, value] of Object.entries(rawData)) {
        if (key === "id") continue;

        // Skip relationship fields - they will be processed separately
        if (relationshipFieldNames.has(key)) continue;

        if (meta.isDateField(key) && value != null) {
          record[key] = new Date(value as string | number);
        } else {
          record[key] = value;
        }
      }

      // Second pass: resolve relationships from nested data
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
            record[rel.fieldName] = targetEntity;

            // Set up bidirectional relationship
            this.setReverseRelationship(entity, targetEntity, rel);
          }
        }
      } else {
        // has-many: Clear and rebuild the array
        const existingArray = record[rel.fieldName] as Model[];
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

    if (reverseRel.isToMany()) {
      const array = targetRecord[reverseRel.fieldName] as Model[];
      if (Array.isArray(array) && !array.includes(entity)) {
        array.push(entity);
      }
    } else {
      targetRecord[reverseRel.fieldName] = entity;
    }
  }
}
