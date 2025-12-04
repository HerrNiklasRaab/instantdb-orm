import { IdentityMap } from "../IdentityMap";
import type { Model } from "../Model";
import { getEntityNames, isValidEntityName, getEntityMeta } from "./EntityMeta";
import { getModelClass } from "./ModelRegistry";
import { ModelHydrator } from "./ModelHydrator";
import { getEntityNameFromClass } from "../decorators";
import type { TxChunk } from "../persistence/types";
import type {
  RawEntityData,
  RootStoreConfig,
  InstantDBClient,
  QueryResult,
} from "./types";

type ModelClass<T extends Model = Model> = new (...args: any[]) => T;

export class RootStore {
  private identityMaps = new Map<string, IdentityMap<Model>>();
  private hydrator: ModelHydrator;
  readonly db: InstantDBClient;

  constructor(config: RootStoreConfig) {
    this.db = config.db;
    this.hydrator = new ModelHydrator(this);
    this.initializeIdentityMaps();
  }

  /** Save model changes to the database */
  async save(model: Model): Promise<void> {
    if (!model._tracker.hasChanges()) {
      return;
    }

    const entityName = model.entityName;
    const changes = model._tracker.getChanges();
    let tx: TxChunk = this.db.tx[entityName][model.id];

    // Scalar updates
    if (changes.scalars.size > 0) {
      const updateData: Record<string, unknown> = {};
      for (const [field, value] of changes.scalars) {
        updateData[field] = value instanceof Date ? value.toISOString() : value;
      }
      tx = tx.update(updateData);
    }

    // Link operations
    for (const [linkName, ids] of changes.links) {
      const label = this.getLinkLabel(entityName, linkName);
      tx = tx.link({ [label]: ids.length === 1 ? ids[0] : ids });
    }

    // Unlink operations
    for (const [linkName, ids] of changes.unlinks) {
      const label = this.getLinkLabel(entityName, linkName);
      tx = tx.unlink({ [label]: ids.length === 1 ? ids[0] : ids });
    }

    await this.db.transact([tx]);
    model._tracker.reset();
  }

  /** Delete a model (soft delete) */
  async delete(model: Model): Promise<void> {
    model.deletedAt = new Date();
    await this.save(model);
  }

  private getLinkLabel(entityName: string, linkName: string): string {
    const meta = getEntityMeta(entityName);
    const rel = meta.relationshipFields.find((r) => r.linkName === linkName);
    return rel?.fieldName ?? linkName;
  }

  private initializeIdentityMaps(): void {
    for (const entityName of getEntityNames()) {
      this.identityMaps.set(entityName, new IdentityMap());
    }
  }

  cleanupRelationships(deletedEntityType: string, deletedModel: Model): void {
    // Find all entity types that have relationships pointing to the deleted entity type
    for (const entityName of getEntityNames()) {
      const meta = getEntityMeta(entityName);
      const identityMap = this.getIdentityMapByName(entityName);

      for (const rel of meta.relationshipFields) {
        if (rel.targetEntity !== deletedEntityType) continue;

        // Check all instances of this entity type
        for (const model of identityMap.values()) {
          const modelRecord = model as unknown as Record<string, unknown>;
          const fieldValue = modelRecord[rel.fieldName];

          if (rel.isToOne()) {
            // Forward reference (one-to-one): set to null if it points to deleted model
            if (fieldValue === deletedModel) {
              modelRecord[rel.fieldName] = null;
            }
          } else {
            // Reverse reference (one-to-many): remove from array
            const arr = fieldValue as Model[] | undefined;
            if (Array.isArray(arr)) {
              const index = arr.indexOf(deletedModel);
              if (index !== -1) {
                arr.splice(index, 1);
              }
            }
          }
        }
      }
    }
  }

  private getIdentityMapByName(entityName: string): IdentityMap<Model> {
    const map = this.identityMaps.get(entityName);
    if (!map) {
      throw new Error(`No identity map for entity: ${entityName}`);
    }
    return map;
  }

  /** Get identity map for an entity class */
  getIdentityMap<T extends Model>(
    EntityClass: ModelClass<T>
  ): IdentityMap<T> {
    const entityName = getEntityNameFromClass(EntityClass);
    return this.getIdentityMapByName(entityName) as IdentityMap<T>;
  }

  /** Get all entities of a class */
  getAll<T extends Model>(EntityClass: ModelClass<T>): T[] {
    return this.getIdentityMap(EntityClass).values() as T[];
  }

  /** Get entity by ID */
  getById<T extends Model>(
    EntityClass: ModelClass<T>,
    id: string
  ): T | undefined {
    return this.getIdentityMap(EntityClass).get(id) as T | undefined;
  }

  /** Watch and hydrate all entities of a class */
  async watchEntity<T extends Model>(
    EntityClass: ModelClass<T>
  ): Promise<T[]> {
    const entityName = getEntityNameFromClass(EntityClass);
    const query = this.buildQueryWithRelationships(entityName);
    const result = (await this.db.query(query)) as QueryResult;

    const rawDataArray = (result[entityName] ?? []) as RawEntityData[];

    return this.hydrator.hydrateMany(
      entityName,
      rawDataArray,
      this.getIdentityMapByName.bind(this)
    ) as T[];
  }

  private buildQueryWithRelationships(
    entityName: string
  ): Record<string, unknown> {
    const meta = getEntityMeta(entityName);
    const relationshipSubqueries: Record<string, unknown> = {};

    // Add relationship subqueries - only request IDs
    for (const rel of meta.relationshipFields) {
      relationshipSubqueries[rel.fieldName] = { $: { fields: ["id"] } };
    }

    return {
      [entityName]:
        Object.keys(relationshipSubqueries).length > 0
          ? relationshipSubqueries
          : {},
    };
  }

  async watchAll(): Promise<void> {
    const entityNames = getEntityNames();
    await Promise.all(
      entityNames.map((name) => {
        const ModelClass = getModelClass(name);
        return this.watchEntity(ModelClass);
      })
    );
  }

  async query(queryObj: Record<string, unknown>): Promise<void> {
    const result = (await this.db.query(queryObj)) as QueryResult;
    this.hydrateResult(result);
  }

  hydrateResult(result: QueryResult): void {
    for (const [entityName, rawDataArray] of Object.entries(result)) {
      if (isValidEntityName(entityName) && Array.isArray(rawDataArray)) {
        this.hydrator.hydrateMany(
          entityName,
          rawDataArray as RawEntityData[],
          this.getIdentityMapByName.bind(this)
        );
      }
    }
  }
}
