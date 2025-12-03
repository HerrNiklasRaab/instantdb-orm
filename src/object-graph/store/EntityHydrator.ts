import { runInAction } from "mobx";
import type { IdentityMap } from "../IdentityMap";
import type { Model } from "../Model";
import {
  getEntityClass,
  type EntityName,
  type EntityInstanceFor,
} from "./EntityRegistry";
import { getEntityMeta, getDateFields, type RelationshipFieldMeta } from "./EntityMeta";
import type { RawEntityData } from "./types";

export type GetIdentityMap = <K extends EntityName>(
  entityName: K
) => IdentityMap<EntityInstanceFor<K>>;

// Pending forward reference - stored when target entity doesn't exist yet
interface PendingForwardRef {
  entity: Model;
  fieldName: string;
  rel: RelationshipFieldMeta;
}

// Callback for when a deleted entity is encountered during hydration
export type OnDeletedEntityCallback = (entityName: EntityName, entity: Model) => void;

export interface EntityHydratorConfig {
  onDeletedEntity?: OnDeletedEntityCallback;
}

export class EntityHydrator {
  // Map from "entityName:entityId" to pending forward references waiting for that entity
  private pendingForwardRefs = new Map<string, PendingForwardRef[]>();
  private onDeletedEntity?: OnDeletedEntityCallback;

  constructor(config?: EntityHydratorConfig) {
    this.onDeletedEntity = config?.onDeletedEntity;
  }

  private getPendingKey(entityName: EntityName, entityId: string): string {
    return `${entityName}:${entityId}`;
  }

  hydrate<K extends EntityName>(
    entityName: K,
    rawData: RawEntityData,
    getIdentityMap: GetIdentityMap
  ): EntityInstanceFor<K> | null {
    const EntityClass = getEntityClass(entityName);
    const identityMap = getIdentityMap(entityName);

    const entity = identityMap.getOrCreate(rawData.id, () => {
      return new EntityClass(rawData.id) as EntityInstanceFor<K>;
    });

    this.updateEntityFields(entity, entityName, rawData, getIdentityMap);

    // Check if entity is soft-deleted
    if (entity.deletedAt != null) {
      // Clean up relationships and remove from identity map
      this.onDeletedEntity?.(entityName, entity);
      identityMap.delete(rawData.id);
      return null;
    }

    // After hydrating, resolve any pending forward refs that were waiting for this entity
    this.resolvePendingForwardRefs(entity, entityName);

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
    const relationshipFieldNames = new Set(
      meta.relationshipFields.map((r) => r.fieldName)
    );

    runInAction(() => {
      // First pass: hydrate scalar fields
      for (const [key, value] of Object.entries(rawData)) {
        if (key === "id") continue;

        // Skip relationship fields - they will be processed separately
        if (relationshipFieldNames.has(key)) continue;

        if (getDateFields().has(key) && value != null) {
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

      if (rel.cardinality === "one") {
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
            this.setReverseRelationship(entity, targetEntity, rel, meta);
          } else {
            // Target doesn't exist yet - store pending forward ref
            this.addPendingForwardRef(rel.targetEntity, firstItem.id, {
              entity,
              fieldName: rel.fieldName,
              rel,
            });
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
              this.setReverseRelationship(entity, targetEntity, rel, meta);
            } else if (!targetEntity) {
              // Target doesn't exist yet - store pending forward ref
              this.addPendingForwardRef(rel.targetEntity, item.id, {
                entity,
                fieldName: rel.fieldName,
                rel,
              });
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

  private addPendingForwardRef(
    targetEntityName: EntityName,
    targetId: string,
    ref: PendingForwardRef
  ): void {
    const key = this.getPendingKey(targetEntityName, targetId);
    const existing = this.pendingForwardRefs.get(key) ?? [];
    existing.push(ref);
    this.pendingForwardRefs.set(key, existing);
  }

  private resolvePendingForwardRefs(
    targetEntity: Model,
    targetEntityName: EntityName
  ): void {
    const key = this.getPendingKey(targetEntityName, targetEntity.id);
    const pendingRefs = this.pendingForwardRefs.get(key);

    if (!pendingRefs || pendingRefs.length === 0) return;

    runInAction(() => {
      for (const { entity, fieldName, rel } of pendingRefs) {
        // Skip if source entity was deleted
        if (entity.deletedAt != null) continue;

        const record = entity as unknown as Record<string, unknown>;
        const meta = getEntityMeta(rel.targetEntity);

        if (rel.cardinality === "one") {
          record[fieldName] = targetEntity;
        } else {
          const array = record[fieldName] as Model[];
          if (Array.isArray(array) && !array.includes(targetEntity)) {
            array.push(targetEntity);
          }
        }

        // Set up bidirectional relationship
        this.setReverseRelationship(entity, targetEntity, rel, meta);
      }
    });

    // Clear resolved refs
    this.pendingForwardRefs.delete(key);
  }

  private setReverseRelationship(
    entity: Model,
    targetEntity: Model,
    rel: { fieldName: string; targetEntity: EntityName; cardinality: "one" | "many"; isForward: boolean; linkName: string },
    _meta: { schemaName: EntityName; scalarFields: string[]; relationshipFields: typeof rel[] }
  ): void {
    // Find the reverse relationship on the target entity
    const targetMeta = getEntityMeta(rel.targetEntity);
    const reverseRel = targetMeta.relationshipFields.find(
      (r) => r.linkName === rel.linkName && r.fieldName !== rel.fieldName
    );

    if (!reverseRel) return;

    const targetRecord = targetEntity as unknown as Record<string, unknown>;

    if (reverseRel.cardinality === "many") {
      const array = targetRecord[reverseRel.fieldName] as Model[];
      if (Array.isArray(array) && !array.includes(entity)) {
        array.push(entity);
      }
    } else {
      targetRecord[reverseRel.fieldName] = entity;
    }
  }
}
