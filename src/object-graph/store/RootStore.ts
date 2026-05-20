import type { AnySchema } from "@upfor/shared";
import type { InstaQLParams } from "@instantdb/core";
import { IdentityMap } from "../IdentityMap";
import { setDebugViewEnabled, Model } from "../Model";
import { getEntityNames, isValidEntityName, getEntityMeta } from "./EntityMeta";
import { getModelClass, getSubclasses } from "./ModelRegistry";
import { ModelHydrator } from "./ModelHydrator";
import { getEntityNameFromClass } from "../decorators";
import { ScopedTransaction, type TransactionStoreAccess } from "../persistence/ScopedTransaction";
import { TransactionContext } from "../persistence/TransactionContext";
import type {
  ModelConstructor,
  RawEntityData,
  RootStoreConfig,
  InstantDBClient,
  QueryResult,
} from "./types";

type ModelClass<T extends Model = Model> = ModelConstructor<T>;

function isInstanceOf<T extends Model>(
  value: Model,
  EntityClass: ModelClass<T>
): value is T {
  return Object.prototype.isPrototypeOf.call(EntityClass.prototype, value);
}

function isQueryResult(value: unknown): value is QueryResult {
  return value !== null && typeof value === "object";
}

export class RootStore<Schema extends AnySchema>
  implements TransactionStoreAccess<Schema>
{
  private identityMaps = new Map<string, IdentityMap<Model>>();
  private subscriptions = new Map<string, { close(): void }>();
  private hydrator: ModelHydrator<Schema>;
  readonly db: InstantDBClient<Schema>;

  constructor(config: RootStoreConfig<Schema>) {
    this.db = config.db;
    setDebugViewEnabled(config.debugView ?? false);
    this.hydrator = new ModelHydrator<Schema>(this);
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
  createTransaction(): ScopedTransaction<Schema> {
    return new ScopedTransaction<Schema>(this);
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
    for (const entityName of getEntityNames()) {
      const meta = getEntityMeta(entityName);
      const identityMap = this.getIdentityMapByName(entityName);

      for (const rel of meta.relationshipFields) {
        if (rel.targetEntity !== deletedEntityType) continue;

        for (const model of identityMap.values()) {
          const fieldValue = rel.read(model);

          if (rel.isToOne()) {
            if (fieldValue === deletedModel) {
              rel.write(model, null);
            }
          } else if (Array.isArray(fieldValue)) {
            const index = fieldValue.indexOf(deletedModel);
            if (index !== -1) {
              fieldValue.splice(index, 1);
            }
          }
        }
      }
    }
  }

  getAll<T extends Model>(EntityClass: ModelClass<T>): T[] {
    const result: T[] = [];
    for (const map of this.identityMapsFor(EntityClass)) {
      for (const entity of map.values()) {
        if (isInstanceOf(entity, EntityClass)) result.push(entity);
      }
    }
    return result;
  }

  getById<T extends Model>(
    EntityClass: ModelClass<T>,
    id: string
  ): T | undefined {
    for (const map of this.identityMapsFor(EntityClass)) {
      const found = map.get(id);
      if (found && isInstanceOf(found, EntityClass)) return found;
    }
    return undefined;
  }

  /**
   * Identity maps that may contain instances of `EntityClass`. For an abstract
   * base class, returns the deduplicated maps of its registered subclasses
   * (STI subclasses share a single map; MTI ones don't). For a concrete class,
   * returns its own map.
   */
  private identityMapsFor(
    EntityClass: ModelClass
  ): IdentityMap<Model>[] {
    const subclasses = getSubclasses(EntityClass);
    const classes: ModelClass[] = subclasses.length > 0 ? subclasses : [EntityClass];
    const seen = new Set<IdentityMap<Model>>();
    const result: IdentityMap<Model>[] = [];
    for (const cls of classes) {
      const entityName = getEntityNameFromClass(cls);
      const map = this.getIdentityMapByName(entityName);
      if (seen.has(map)) continue;
      seen.add(map);
      result.push(map);
    }
    return result;
  }

  /** One-time query and hydrate all entities of a class */
  async queryModel<T extends Model>(
    EntityClass: ModelClass<T>
  ): Promise<T[]> {
    const entityName = getEntityNameFromClass(EntityClass);
    const queryInput: InstaQLParams<Schema> = {};
    Reflect.set(queryInput, entityName, {});
    const query = this.buildQueryWithRelationships(queryInput);
    const raw = await this.db.query(query);
    if (!isQueryResult(raw)) {
      throw new TypeError(`InstantDB.query: expected an object result, got ${typeof raw}`);
    }

    const rawDataArray = raw[entityName] ?? [];

    const hydrated = this.hydrator.hydrateMany(
      entityName,
      rawDataArray,
      this.getIdentityMapByName.bind(this)
    );
    return hydrated.filter((m): m is T => isInstanceOf(m, EntityClass));
  }

  /** Generic subscription helper for DRY subscription logic */
  private createSubscription<T>(
    subscriptionKey: string,
    query: InstaQLParams<Schema>,
    onData: (data: QueryResult) => T,
    callback?: (result: T) => void
  ): Promise<{ result: T; close: () => void }> {
    this.subscriptions.get(subscriptionKey)?.close();

    return new Promise((resolve, reject) => {
      let isFirstCallback = true;

      const unsubscribe = this.db.subscribeQuery(
        query,
        ({ error, data }) => {
          if (error) {
            console.error(`Subscription error for ${subscriptionKey}:`, error.message);
            if (isFirstCallback) {
              reject(new Error(error.message));
            }
            return;
          }
          if (isQueryResult(data)) {
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
    const queryInput: InstaQLParams<Schema> = {};
    Reflect.set(queryInput, entityName, {});
    const query = this.buildQueryWithRelationships(queryInput);

    const { result: entities, close } = await this.createSubscription(
      entityName,
      query,
      (data): T[] => {
        const rawDataArray = data[entityName] ?? [];
        const hydrated = this.hydrator.hydrateMany(
          entityName,
          rawDataArray,
          this.getIdentityMapByName.bind(this)
        );
        return hydrated.filter((m): m is T => isInstanceOf(m, EntityClass));
      },
      callback
    );

    return { entities, close };
  }

  private buildQueryWithRelationships(
    queryObj: InstaQLParams<Schema>,
    visited: Set<string> = new Set()
  ): InstaQLParams<Schema> {
    const expanded: InstaQLParams<Schema> = {};

    for (const key of Object.keys(queryObj)) {
      const value: unknown = Reflect.get(queryObj, key);

      if (key === "$" || !isValidEntityName(key)) {
        Reflect.set(expanded, key, value);
        continue;
      }

      if (visited.has(key)) {
        Reflect.set(expanded, key, { $: { fields: ["id"] } });
        continue;
      }
      visited.add(key);

      const meta = getEntityMeta(key);
      const subquery: object =
        typeof value === "object" && value !== null ? { ...value } : {};

      for (const rel of meta.relationshipFields) {
        if (!Reflect.has(subquery, rel.fieldName)) {
          Reflect.set(subquery, rel.fieldName, { $: { fields: ["id"] } });
          continue;
        }
        const existing: unknown = Reflect.get(subquery, rel.fieldName);
        const nestedInput: InstaQLParams<Schema> = {};
        Reflect.set(nestedInput, rel.targetEntity, existing);
        const nestedExpanded = this.buildQueryWithRelationships(
          nestedInput,
          new Set(visited)
        );
        Reflect.set(
          subquery,
          rel.fieldName,
          Reflect.get(nestedExpanded, rel.targetEntity)
        );
      }

      Reflect.set(expanded, key, subquery);
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
      void this.subscribeModel(ModelClass, () => {
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

  async query(queryObj: InstaQLParams<Schema>): Promise<void> {
    const expandedQuery = this.buildQueryWithRelationships(queryObj);
    const raw = await this.db.query(expandedQuery);
    if (!isQueryResult(raw)) {
      throw new TypeError(`InstantDB.query: expected an object result, got ${typeof raw}`);
    }
    this.hydrateResult(raw);
  }

  hydrateResult(result: QueryResult): void {
    for (const [entityName, rawDataArray] of Object.entries(result)) {
      if (isValidEntityName(entityName) && Array.isArray(rawDataArray)) {
        this.hydrator.hydrateMany(
          entityName,
          rawDataArray,
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
    queryObj: InstaQLParams<Schema>,
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
    queryObj: InstaQLParams<Schema>,
    handler: (store: RootStore<Schema>, prev: RootStore<Schema> | null) => Promise<void> | void
  ): Promise<{ close(): void }> {
    const expandedQuery = this.buildQueryWithRelationships(queryObj);
    const config: RootStoreConfig<Schema> = { db: this.db };

    let prevStore: RootStore<Schema> | null = null;
    let queue: Promise<void> = Promise.resolve();
    let closed = false;
    let firstResolved = false;

    return new Promise<{ close(): void }>((resolve, reject) => {
      const unsubscribe = this.db.subscribeQuery(
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
          if (!isQueryResult(data)) return;

          queue = queue.then(async () => {
            if (closed) {
              prevStore?.dispose();
              prevStore = null;
              return;
            }
            const callbackStore = new RootStore<Schema>(config);
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
