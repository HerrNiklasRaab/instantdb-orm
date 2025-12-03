import { IdentityMap } from "../IdentityMap";
import type { Model } from "../Model";
import { getEntityNames, isValidEntityName } from "./EntityRegistry";
import { getEntityMeta } from "./EntityMeta";
import { EntityHydrator } from "./EntityHydrator";
import type {
  RawEntityData,
  RootStoreConfig,
  InstantDBClient,
  QueryResult,
  EntityConstructor,
} from "./types";

export class RootStore<
  TRegistry extends Record<string, EntityConstructor> = Record<
    string,
    EntityConstructor
  >
> {
  private identityMaps = new Map<string, IdentityMap<Model>>();
  private hydrator: EntityHydrator;
  private db: InstantDBClient;

  constructor(config: RootStoreConfig) {
    this.db = config.db;
    this.hydrator = new EntityHydrator({
      onDeletedEntity: this.cleanupRelationships.bind(this),
    });
    this.initializeIdentityMaps();
  }

  private initializeIdentityMaps(): void {
    for (const entityName of getEntityNames()) {
      this.identityMaps.set(entityName, new IdentityMap());
    }
  }

  private cleanupRelationships(deletedEntityType: string, deletedEntity: Model): void {
    // Find all entity types that have relationships pointing to the deleted entity type
    for (const entityName of getEntityNames()) {
      const meta = getEntityMeta(entityName);
      const identityMap = this.getIdentityMap(entityName);

      for (const rel of meta.relationshipFields) {
        if (rel.targetEntity !== deletedEntityType) continue;

        // Check all instances of this entity type
        for (const entity of identityMap.values()) {
          const entityRecord = entity as unknown as Record<string, unknown>;
          const fieldValue = entityRecord[rel.fieldName];

          if (rel.cardinality === "one") {
            // Forward reference (one-to-one): set to null if it points to deleted entity
            if (fieldValue === deletedEntity) {
              entityRecord[rel.fieldName] = null;
            }
          } else {
            // Reverse reference (one-to-many): remove from array
            const arr = fieldValue as Model[] | undefined;
            if (Array.isArray(arr)) {
              const index = arr.indexOf(deletedEntity);
              if (index !== -1) {
                arr.splice(index, 1);
              }
            }
          }
        }
      }
    }
  }

  getIdentityMap<K extends keyof TRegistry & string>(
    entityName: K
  ): IdentityMap<InstanceType<TRegistry[K]>> {
    const map = this.identityMaps.get(entityName);
    if (!map) {
      throw new Error(`No identity map for entity: ${entityName}`);
    }
    return map as IdentityMap<InstanceType<TRegistry[K]>>;
  }

  getAll<K extends keyof TRegistry & string>(
    entityName: K
  ): InstanceType<TRegistry[K]>[] {
    return this.getIdentityMap(entityName).values();
  }

  getById<K extends keyof TRegistry & string>(
    entityName: K,
    id: string
  ): InstanceType<TRegistry[K]> | undefined {
    return this.getIdentityMap(entityName).get(id);
  }

  async watchEntity<K extends keyof TRegistry & string>(
    entityName: K
  ): Promise<InstanceType<TRegistry[K]>[]> {
    const query = this.buildQueryWithRelationships(entityName);
    const result = (await this.db.query(query)) as QueryResult;

    const rawDataArray = (result[entityName] ?? []) as RawEntityData[];

    return this.hydrator.hydrateMany(
      entityName,
      rawDataArray,
      this.getIdentityMap.bind(this)
    ) as InstanceType<TRegistry[K]>[];
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
    await Promise.all(entityNames.map((name) => this.watchEntity(name)));
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
          this.getIdentityMap.bind(this)
        );
      }
    }
  }
}
