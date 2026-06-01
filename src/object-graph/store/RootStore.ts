import type { AnySchema } from "../../instantdb";
import type { InstaQLParams, InstaQLResponse, ValidQuery } from "@instantdb/core";
import { observable, runInAction } from "mobx";

import { IdentityMap } from "../IdentityMap";
import { setDebugViewEnabled, Model } from "../Model";
import { getEntityNames, isValidEntityName, getEntityLinks, readField, writeField } from "./EntityMeta";
import { getModelClass, getSubclasses } from "./ModelRegistry";
import { ModelHydrator } from "./ModelHydrator";
import { getEntityNameFromClass } from "../decorators";
import { ScopedTransaction, type TransactionStoreAccess } from "../persistence/ScopedTransaction";
import { TransactionContext } from "../persistence/TransactionContext";
import { InstantDBClient } from "./types";
import type {
  ModelConstructor,
  RawEntityData,
  RootStoreConfig,
} from "./types";

type ModelClass<T extends Model = Model> = ModelConstructor<T>;

function isInstanceOf<T extends Model>(
  value: Model,
  EntityClass: ModelClass<T>
): value is T {
  if (Object.prototype.isPrototypeOf.call(EntityClass.prototype, value)) return true;
  // Cross-bundle fallback: EntityClass may be a duplicate class identity from
  // another bundle. Re-resolve through the shared registry. For STI concrete
  // classes, discriminate by modelType so we don't falsely accept siblings.
  const expectedDiscriminator = Reflect.get(EntityClass.prototype, "modelType") as unknown;
  const subclasses = getSubclasses(EntityClass);
  const candidates: ModelClass[] = subclasses.length > 0 ? subclasses : [EntityClass];
  for (const cls of candidates) {
    try {
      const canonical = getModelClass(getEntityNameFromClass(cls));
      if (!Object.prototype.isPrototypeOf.call(canonical.prototype, value)) continue;
      if (typeof expectedDiscriminator === "string") {
        const actualDiscriminator = Reflect.get(value, "modelType") as unknown;
        if (actualDiscriminator !== expectedDiscriminator) continue;
      }
      return true;
    } catch {
      // class has no entity name (abstract w/o registered subclasses) — skip
    }
  }
  return false;
}

function isRawEntityData(v: unknown): v is RawEntityData {
  return (
    typeof v === "object" &&
    v !== null &&
    "id" in v &&
    typeof v.id === "string"
  );
}

function toRawEntityArray(v: unknown): RawEntityData[] {
  return Array.isArray(v) ? v.filter(isRawEntityData) : [];
}

export class RootStore<Schema extends AnySchema>
  implements TransactionStoreAccess<Schema> {
  private identityMaps = new Map<string, IdentityMap<Model>>();
  private subscriptions = new Map<string, { close(): void }>();
  private hydrator: ModelHydrator<Schema>;
  private _initialSyncComplete = observable.box(false);
  readonly db: InstantDBClient<Schema>;

  constructor(config: RootStoreConfig<Schema>) {
    this.db = config.db;
    setDebugViewEnabled(config.debugView ?? false);
    this.hydrator = new ModelHydrator<Schema>(this);
    this.initializeIdentityMaps();
  }

  dispose(): void { }

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

  private entityNameOf(EntityClass: ModelClass): keyof Schema["entities"] & string {
    return getEntityNameFromClass(EntityClass);
  }

  getIdentityMapByName(entityName: string): IdentityMap<Model> {
    const map = this.identityMaps.get(entityName);
    if (!map) {
      throw new Error(`No identity map for entity: ${entityName}`);
    }
    return map;
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
      const identityMap = this.getIdentityMapByName(entityName);

      for (const [fieldName, linkAttr] of Object.entries(getEntityLinks(entityName))) {
        if (linkAttr.entityName !== deletedEntityType) continue;

        for (const model of identityMap.values()) {
          const fieldValue = readField(model, fieldName);

          if (linkAttr.cardinality === "one") {
            if (fieldValue === deletedModel) {
              writeField(model, fieldName, null);
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
    const entityName = this.entityNameOf(EntityClass);
    const queryInput: InstaQLParams<Schema> = {};
    queryInput[entityName] = {};
    const query = this.buildQueryWithRelationships(queryInput);
    const raw = await this.db.unsafeQuery(query);
    const rawDataArray = toRawEntityArray(Reflect.get(raw, entityName));

    const hydrated = this.hydrator.hydrateMany(
      entityName,
      rawDataArray,
      this.getIdentityMapByName.bind(this)
    );
    return hydrated.filter((m): m is T => isInstanceOf(m, EntityClass));
  }

  private createSubscription<Q extends InstaQLParams<Schema>, T>(
    subscriptionKey: string,
    query: Q,
    onData: (data: InstaQLResponse<Schema, Q>) => T,
    callback?: (result: T) => void
  ): Promise<{ result: T; close: () => void }> {
    this.subscriptions.get(subscriptionKey)?.close();

    return new Promise((resolve, reject) => {
      let isFirstCallback = true;

      const unsubscribe = this.db.unsafeSubscribeQuery(
        query,
        ({ error, data }) => {
          if (error) {
            console.error(`Subscription error for ${subscriptionKey}:`, error.message);
            if (isFirstCallback) {
              reject(new Error(error.message));
            }
            return;
          }
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
      );
    });
  }

  /** Subscribe to live updates for all entities of a class */
  async subscribeModel<T extends Model>(
    EntityClass: ModelClass<T>,
    callback: (entities: T[]) => void
  ): Promise<{ entities: T[]; close(): void }> {
    const entityName = this.entityNameOf(EntityClass);
    const queryInput: InstaQLParams<Schema> = {};
    queryInput[entityName] = {};
    const query = this.buildQueryWithRelationships(queryInput);

    const { result: entities, close } = await this.createSubscription(
      entityName,
      query,
      (data): T[] => {
        const rawDataArray = toRawEntityArray(Reflect.get(data, entityName));
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

  private buildQueryWithRelationships<Q extends InstaQLParams<Schema>>(
    queryObj: Q,
    visited: Set<string> = new Set()
  ): Q {
    const expanded = { ...queryObj };
    for (const key of Object.keys(expanded)) {
      if (key === "$" || !isValidEntityName(key)) continue;

      if (visited.has(key)) {
        Reflect.set(expanded, key, { $: { fields: ["id"] } });
        continue;
      }
      visited.add(key);

      const value: unknown = Reflect.get(expanded, key);
      const subquery: InstaQLParams<Schema> =
        typeof value === "object" && value !== null ? { ...value } : {};
      Reflect.set(expanded, key, subquery);

      for (const [fieldName, linkAttr] of Object.entries(getEntityLinks(key))) {
        if (!Reflect.has(subquery, fieldName)) {
          Reflect.set(subquery, fieldName, { $: { fields: ["id"] } });
          continue;
        }
        const existing: unknown = Reflect.get(subquery, fieldName);
        const wrapper: InstaQLParams<Schema> = {};
        Reflect.set(wrapper, linkAttr.entityName, existing);
        const expandedWrapper = this.buildQueryWithRelationships(wrapper, new Set(visited));
        Reflect.set(subquery, fieldName, Reflect.get(expandedWrapper, linkAttr.entityName));
      }
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
  /**
   * True once every entity subscription opened by `subscribeAll` has delivered
   * its first snapshot. Observable — read it from an `observer` to gate UI on
   * the store being hydrated (e.g. onboarding routing must not decide before
   * the user's relationships have synced).
   */
  get initialSyncComplete(): boolean {
    return this._initialSyncComplete.get();
  }

  subscribeAll(callback?: () => void): { close(): void } {
    const entityNames = getEntityNames();
    runInAction(() => { this._initialSyncComplete.set(false); });

    const firstSnapshots = entityNames.map((name) => {
      const ModelClass = getModelClass(name);
      return this.subscribeModel(ModelClass, () => {
        callback?.();
      });
    });

    void Promise.allSettled(firstSnapshots).then(() => {
      runInAction(() => { this._initialSyncComplete.set(true); });
    });

    return {
      close: () => {
        for (const sub of this.subscriptions.values()) {
          sub.close();
        }
      },
    };
  }

  async query<Q extends InstaQLParams<Schema>>(
    queryObj: Q & ValidQuery<Q, Schema>
  ): Promise<void> {
    const expandedQuery = this.buildQueryWithRelationships(queryObj);
    const raw = await this.db.unsafeQuery(expandedQuery);
    this.hydrateResult(raw);
  }

  hydrateResult(result: object): void {
    for (const entityName of Object.keys(result)) {
      if (!isValidEntityName(entityName)) continue;
      const rawDataArray = toRawEntityArray(Reflect.get(result, entityName));
      this.hydrator.hydrateMany(
        entityName,
        rawDataArray,
        this.getIdentityMapByName.bind(this)
      );
    }
  }

  /**
   * Subscribe to a query with live updates.
   * Automatically hydrates results on each update.
   */
  async subscribeQuery<Q extends InstaQLParams<Schema>>(
    queryObj: Q & ValidQuery<Q, Schema>,
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
  async subscribeQueryIsolated<Q extends InstaQLParams<Schema>>(
    queryObj: Q & ValidQuery<Q, Schema>,
    handler: (store: RootStore<Schema>, prev: RootStore<Schema> | null) => Promise<void> | void
  ): Promise<{ close(): void }> {
    const expandedQuery = this.buildQueryWithRelationships(queryObj);
    const config: RootStoreConfig<Schema> = { db: this.db };

    let prevStore: RootStore<Schema> | null = null;
    let queue: Promise<void> = Promise.resolve();
    let closed = false;
    let firstResolved = false;

    return new Promise<{ close(): void }>((resolve, reject) => {
      const unsubscribe = this.db.unsafeSubscribeQuery(
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
