import { IdentityMap } from "../IdentityMap";
import type { Model } from "../Model";
import { getEntityNames, isValidEntityName, getEntityMeta } from "./EntityMeta";
import { getModelClass, getSubclasses } from "./ModelRegistry";
import { ModelHydrator } from "./ModelHydrator";
import { getEntityNameFromClass } from "../decorators";
import type { TxChunk } from "../persistence/types";
import { Transaction, type TransactionStoreAccess } from "../persistence/Transaction";
import type {
  RawEntityData,
  RootStoreConfig,
  InstantDBClient,
  QueryResult,
} from "./types";

// Use Function & prototype pattern to allow private constructors (hydration-only models)
type ModelClass<T extends Model = Model> = (abstract new (...args: any[]) => T) | (Function & { prototype: T });

export class RootStore implements TransactionStoreAccess {
  private identityMaps = new Map<string, IdentityMap<Model>>();
  private subscriptions = new Map<string, { close(): void }>();
  private hydrator: ModelHydrator;
  private activeTransaction: Transaction | null = null;
  readonly db: InstantDBClient;

  constructor(config: RootStoreConfig) {
    this.db = config.db;
    this.hydrator = new ModelHydrator(this);
    this.initializeIdentityMaps();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Transaction API
  // ─────────────────────────────────────────────────────────────────────────────

  /** Check if a transaction is active */
  get hasActiveTransaction(): boolean {
    return this.activeTransaction !== null;
  }

  /** Start a new transaction - captures current state for rollback */
  startTransaction(): void {
    if (this.activeTransaction) {
      throw new Error("Transaction already active");
    }
    this.activeTransaction = new Transaction(this);

    // Register callbacks to track new models added during transaction
    for (const identityMap of this.identityMaps.values()) {
      identityMap.setOnModelAdded((model) => {
        this.activeTransaction?.registerNew(model);
      });
    }
  }

  /** Commit all dirty models atomically */
  async commitTransaction(): Promise<void> {
    if (!this.activeTransaction) {
      throw new Error("No active transaction");
    }
    try {
      await this.activeTransaction.commit();
    } finally {
      this.clearTransactionHooks();
    }
  }

  /** Rollback all changes to pre-transaction state */
  undoTransaction(): void {
    if (!this.activeTransaction) {
      throw new Error("No active transaction");
    }
    try {
      this.activeTransaction.rollback();
    } finally {
      this.clearTransactionHooks();
    }
  }

  private clearTransactionHooks(): void {
    for (const identityMap of this.identityMaps.values()) {
      identityMap.clearOnModelAdded();
    }
    this.activeTransaction = null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TransactionStoreAccess implementation
  // ─────────────────────────────────────────────────────────────────────────────

  getIdentityMaps(): Map<string, IdentityMap<Model>> {
    return this.identityMaps;
  }

  getIdentityMapByName(entityName: string): IdentityMap<Model> {
    const map = this.identityMaps.get(entityName);
    if (!map) {
      throw new Error(`No identity map for entity: ${entityName}`);
    }
    return map;
  }

  getLinkLabel(entityName: string, linkName: string): string {
    const meta = getEntityMeta(entityName);
    const rel = meta.relationshipFields.find((r) => r.linkName === linkName);
    return rel?.fieldName ?? linkName;
  }

  rehydrateModel(model: Model, rawData: RawEntityData): void {
    this.hydrator.rehydrate(model, rawData, this.getIdentityMapByName.bind(this));
  }

  /** Save model changes to the database */
  async save(model: Model): Promise<void> {
    if (!model._tracker!.hasChanges()) {
      return;
    }

    // Auto-add to identity map if not present (enables automatic transaction tracking)
    const entityName = model.entityName;
    const identityMap = this.getIdentityMapByName(entityName);
    if (!identityMap.has(model.id)) {
      identityMap.set(model);
    }

    // Update timestamp before getting changes
    model.setUpdatedAt();

    const changes = model._tracker!.getChanges();
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
    model._tracker!.reset();
  }

  /** Delete a model (soft delete) */
  async delete(model: Model): Promise<void> {
    model.markDeleted();
    await this.save(model);
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

  /** Get identity map for an entity class */
  getIdentityMap<T extends Model>(
    EntityClass: ModelClass<T>
  ): IdentityMap<T> {
    const entityName = getEntityNameFromClass(EntityClass);
    return this.getIdentityMapByName(entityName) as unknown as IdentityMap<T>;
  }

  /** Get all entities of a class (supports polymorphic queries for base classes) */
  getAll<T extends Model>(EntityClass: ModelClass<T>): T[] {
    const subclasses = getSubclasses(EntityClass);

    if (subclasses.length > 0) {
      const results: T[] = [];
      for (const SubClass of subclasses) {
        results.push(...this.getIdentityMap(SubClass).values() as T[]);
      }
      return results;
    }

    // Filter by instanceof to handle STI (where identity map is shared across subtypes)
    return this.getIdentityMap(EntityClass)
      .values()
      .filter((entity) => entity instanceof EntityClass) as T[];
  }

  /** Get entity by ID */
  getById<T extends Model>(
    EntityClass: ModelClass<T>,
    id: string
  ): T | undefined {
    return this.getIdentityMap(EntityClass).get(id) as T | undefined;
  }

  /** One-time query and hydrate all entities of a class */
  async queryModel<T extends Model>(
    EntityClass: ModelClass<T>
  ): Promise<T[]> {
    const entityName = getEntityNameFromClass(EntityClass);
    const query = this.buildQueryWithRelationships({ [entityName]: {} });
    const result = (await this.db.query(query)) as QueryResult;

    const rawDataArray = (result[entityName] ?? []) as RawEntityData[];

    return this.hydrator.hydrateMany(
      entityName,
      rawDataArray,
      this.getIdentityMapByName.bind(this)
    ) as T[];
  }

  /** Generic subscription helper for DRY subscription logic */
  private createSubscription<T>(
    subscriptionKey: string,
    query: Record<string, unknown>,
    onData: (data: QueryResult) => T,
    callback?: (result: T) => void
  ): Promise<{ result: T; close(): void }> {
    this.subscriptions.get(subscriptionKey)?.close();

    return new Promise((resolve, reject) => {
      let isFirstCallback = true;

      const unsubscribe = this.db.subscribeQuery<QueryResult>(
        query,
        ({ error, data }) => {
          if (error) {
            console.error(`Subscription error for ${subscriptionKey}:`, error.message);
            if (isFirstCallback) {
              reject(new Error(error.message));
            }
            return;
          }
          if (data) {
            const result = onData(data);

            if (isFirstCallback) {
              isFirstCallback = false;
              const subscription = {
                result,
                close: () => {
                  unsubscribe();
                  this.subscriptions.delete(subscriptionKey);
                },
              };
              this.subscriptions.set(subscriptionKey, subscription);
              resolve(subscription);
            }

            callback?.(result);
          }
        }
      );
    });
  }

  /** Subscribe to live updates for all entities of a class */
  async subscribeModel<T extends Model>(
    EntityClass: ModelClass<T>,
    callback: (entities: T[]) => void
  ): Promise<{ entities: T[]; close(): void }> {
    const entityName = getEntityNameFromClass(EntityClass);
    const query = this.buildQueryWithRelationships({ [entityName]: {} });

    const { result: entities, close } = await this.createSubscription(
      entityName,
      query,
      (data) => {
        const rawDataArray = (data[entityName] ?? []) as RawEntityData[];
        return this.hydrator.hydrateMany(
          entityName,
          rawDataArray,
          this.getIdentityMapByName.bind(this)
        ) as T[];
      },
      callback
    );

    return { entities, close };
  }

  private buildQueryWithRelationships(
    queryObj: Record<string, unknown>,
    visited: Set<string> = new Set()
  ): Record<string, unknown> {
    const expanded: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(queryObj)) {
      // Skip $ (query options like where, limit, etc.)
      if (key === "$") {
        expanded[key] = value;
        continue;
      }

      // Check if this key is a valid entity name
      if (!isValidEntityName(key)) {
        expanded[key] = value;
        continue;
      }

      // Prevent infinite recursion for circular relationships
      if (visited.has(key)) {
        expanded[key] = { $: { fields: ["id"] } };
        continue;
      }
      visited.add(key);

      // Get entity metadata
      const meta = getEntityMeta(key);
      const subquery =
        typeof value === "object" && value !== null
          ? { ...(value as Record<string, unknown>) }
          : {};

      // Add all relationship subqueries for this entity
      for (const rel of meta.relationshipFields) {
        if (!(rel.fieldName in subquery)) {
          subquery[rel.fieldName] = { $: { fields: ["id"] } };
        } else {
          // Recursively expand existing relationship subquery
          subquery[rel.fieldName] = this.buildQueryWithRelationships(
            { [rel.targetEntity]: subquery[rel.fieldName] },
            new Set(visited)
          )[rel.targetEntity];
        }
      }

      expanded[key] = subquery;
    }

    return expanded;
  }

  /** One-time query and hydrate all registered entity classes */
  async queryAll(): Promise<void> {
    const entityNames = getEntityNames();
    await Promise.all(
      entityNames.map((name) => {
        const ModelClass = getModelClass(name);
        return this.queryModel(ModelClass);
      })
    );
  }

  /** Subscribe to live updates for all registered entity classes */
  subscribeAll(callback?: () => void): { close(): void } {
    const entityNames = getEntityNames();

    for (const name of entityNames) {
      const ModelClass = getModelClass(name);
      this.subscribeModel(ModelClass, () => {
        callback?.();
      });
    }

    return {
      close: () => {
        for (const sub of this.subscriptions.values()) {
          sub.close();
        }
      },
    };
  }

  async query(queryObj: Record<string, unknown>): Promise<void> {
    const expandedQuery = this.buildQueryWithRelationships(queryObj);
    const result = (await this.db.query(expandedQuery)) as QueryResult;
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

  /**
   * Subscribe to a query with live updates.
   * Automatically hydrates results on each update.
   */
  async subscribeQuery(
    queryObj: Record<string, unknown>,
    callback?: () => void
  ): Promise<{ close(): void }> {
    const expandedQuery = this.buildQueryWithRelationships(queryObj);
    const queryKey = JSON.stringify(queryObj);

    const { close } = await this.createSubscription(
      queryKey,
      expandedQuery,
      (data) => {
        this.hydrateResult(data);
      },
      callback
    );

    return { close };
  }
}
