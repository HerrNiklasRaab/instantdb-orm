import { IdentityMap } from "../IdentityMap";
import { setDebugViewEnabled, type Model } from "../Model";
import { getEntityNames, isValidEntityName, getEntityMeta } from "./EntityMeta";
import { getModelClass, getSubclasses } from "./ModelRegistry";
import { ModelHydrator } from "./ModelHydrator";
import { getEntityNameFromClass } from "../decorators";
import { ScopedTransaction, type TransactionStoreAccess } from "../persistence/ScopedTransaction";
import { TransactionContext } from "../persistence/TransactionContext";
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
  readonly db: InstantDBClient;

  constructor(config: RootStoreConfig) {
    this.db = config.db;
    setDebugViewEnabled(config.debugView ?? false);
    this.hydrator = new ModelHydrator(this);
    this.initializeIdentityMaps();
  }

  dispose(): void {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Transaction API
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a long-lived transaction for manual commit/rollback.
   * Use tx.run(() => { ... }) to make mutations within its scope.
   */
  createTransaction(): ScopedTransaction {
    return new ScopedTransaction(this);
  }

  /**
   * Run a callback within a short-lived transaction.
   * Auto-commits on success, auto-rollback on error.
   * Returns whatever the callback returns.
   */
  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    const tx = this.createTransaction();
    let result: T;
    try {
      result = await TransactionContext.run(tx, fn);
    } catch (e) {
      tx.rollback();
      throw e;
    }
    await tx.commit();
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TransactionStoreAccess implementation
  // ─────────────────────────────────────────────────────────────────────────────

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
    const result: T[] = [];
    for (const map of this.identityMapsFor(EntityClass)) {
      for (const entity of map.values()) {
        if (entity instanceof (EntityClass as Function)) result.push(entity as T);
      }
    }
    return result;
  }

  /** Get entity by ID (supports polymorphic lookup for base classes) */
  getById<T extends Model>(
    EntityClass: ModelClass<T>,
    id: string
  ): T | undefined {
    for (const map of this.identityMapsFor(EntityClass)) {
      const found = map.get(id);
      if (found && found instanceof (EntityClass as Function)) return found as T;
    }
    return undefined;
  }

  /**
   * Identity maps that may contain instances of `EntityClass`. For an abstract
   * base class, returns the deduplicated maps of its registered subclasses
   * (STI subclasses share a single map; MTI ones don't). For a concrete class,
   * returns its own map.
   */
  private identityMapsFor<T extends Model>(
    EntityClass: ModelClass<T>
  ): IdentityMap<T>[] {
    const subclasses = getSubclasses(EntityClass);
    const classes = subclasses.length > 0 ? subclasses : [EntityClass];
    const seen = new Set<IdentityMap<Model>>();
    const result: IdentityMap<T>[] = [];
    for (const cls of classes) {
      const map = this.getIdentityMap(cls);
      if (seen.has(map)) continue;
      seen.add(map);
      result.push(map as IdentityMap<T>);
    }
    return result;
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

  /**
   * Subscribe to a query and invoke `handler` with a freshly hydrated, isolated
   * store on each update. The handler also receives the previous callback's store
   * (or `null` on the first callback), so it can compare states — e.g. detect
   * entered/removed/changed entities by walking identity maps. The previous store
   * is disposed after the handler returns; do not retain references to its models.
   * Overlapping updates are serialized — handler N+1 starts only after handler N
   * finishes (or rejects). The outer store is not mutated.
   */
  async subscribeQueryIsolated(
    queryObj: Record<string, unknown>,
    handler: (store: RootStore, prev: RootStore | null) => Promise<void> | void
  ): Promise<{ close(): void }> {
    const expandedQuery = this.buildQueryWithRelationships(queryObj);
    const config: RootStoreConfig = { db: this.db };

    let prevStore: RootStore | null = null;
    let queue: Promise<void> = Promise.resolve();
    let closed = false;
    let firstResolved = false;

    return new Promise<{ close(): void }>((resolve, reject) => {
      const unsubscribe = this.db.subscribeQuery<QueryResult>(
        expandedQuery,
        ({ error, data }) => {
          if (closed) return;
          if (error) {
            console.error("subscribeQueryIsolated error:", error.message);
            if (!firstResolved) {
              firstResolved = true;
              reject(new Error(error.message));
            }
            return;
          }
          if (!data) return;

          queue = queue.then(async () => {
            if (closed) {
              prevStore?.dispose();
              prevStore = null;
              return;
            }
            const callbackStore = new RootStore(config);
            try {
              callbackStore.hydrateResult(data);
              await handler(callbackStore, prevStore);
            } catch (err) {
              console.error("subscribeQueryIsolated callback failed:", err);
            } finally {
              prevStore?.dispose();
              prevStore = callbackStore;
            }
          });

          if (!firstResolved) {
            firstResolved = true;
            resolve({
              close: () => {
                closed = true;
                unsubscribe();
                const cleanup = () => {
                  prevStore?.dispose();
                  prevStore = null;
                };
                queue = queue.then(cleanup, cleanup);
              },
            });
          }
        }
      );
    });
  }
}
