import { observable, runInAction } from "mobx";
import type { Settled, TransactionHandle } from "./TransactionHandle";
import type { SchemaDef } from "@zenstackhq/schema";
import { ReplicaChange, type PresenceRoom, type SyncClient } from "../../client";
import { type QueryResult, type SyncQuery, type UntypedQuery, isRecord, untypedQuery } from "../../queries";
import { type QuerySubscriptionState } from "../../subscriptions";
import { type TransactionEffect, type TransactionOutcome } from "../../transactions";

import { ResilientSubscription } from "../../subscriptions/ResilientSubscription";
import {
  ConsoleSubscriptionObserver,
  type SubscriptionObserver,
} from "../../subscriptions/SubscriptionObserver";

import { IdentityMap } from "../IdentityMap";
import { setDebugViewEnabled, Model } from "../Model";
import { configureEntityMeta, getEntityNames, isValidEntityName, getEntityLinks, readField, writeField } from "./EntityMeta";
import { getModelClass, getModelClassForDiscriminator, getSubclasses, hasDiscriminatorMapping, isRegisteredModel } from "./ModelRegistry";
import { ModelHydrator } from "./ModelHydrator";
import { getEntityNameFromClass } from "../decorators";
import { ScopedTransaction, type TransactionStoreAccess } from "../persistence/ScopedTransaction";
import { TransactionContext } from "../persistence/TransactionContext";
import { withHydration } from "./hydrationContext";
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
  const expectedDiscriminator: unknown = Reflect.get(EntityClass.prototype, "modelType");
  const subclasses = getSubclasses(EntityClass);
  const candidates: ModelClass[] = subclasses.length > 0 ? subclasses : [EntityClass];
  for (const cls of candidates) {
    try {
      const entityName = getEntityNameFromClass(cls);
      // An STI table holds one class per discriminator and none under the
      // entity name, so resolving by name alone lands on whichever subclass
      // registered first — a sibling, which rejects every other subtype.
      const canonical = typeof expectedDiscriminator === "string"
        ? getModelClassForDiscriminator(entityName, expectedDiscriminator)
        : getModelClass(entityName);
      if (!canonical) continue;
      if (!Object.prototype.isPrototypeOf.call(canonical.prototype, value)) continue;
      if (typeof expectedDiscriminator === "string") {
        const actualDiscriminator: unknown = Reflect.get(value, "modelType");
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

// One listener per configured callback, however many stores share the
// config: isolated callback stores must not multiply reports.
const reporters = new WeakMap<(outcome: TransactionOutcome) => void, (denial: TransactionEffect) => void>();

function reporterFor(report: (outcome: TransactionOutcome) => void): (denial: TransactionEffect) => void {
  let reporter = reporters.get(report);
  if (!reporter) {
    reporter = (denial) => { report(denial); };
    reporters.set(report, reporter);
  }
  return reporter;
}

export class RootStore<Schema extends SchemaDef> implements TransactionStoreAccess {
  private identityMaps = new Map<string, IdentityMap<Model>>();
  private subscriptions = new Map<string, { close(): void }>();
  private hydrator: ModelHydrator;
  // Following the replica: everything it holds once the first sync is in, then
  // the rows each server message wrote or removed, read back from it.
  private readonly loaded = observable.box(false);
  private readonly pendingChange = new ReplicaChange();
  private passScheduled = false;
  private following: Promise<void> = Promise.resolve();
  private stopFollowing: (() => void) | null = null;
  private readonly notFollowed = new Set<string>();
  readonly client: SyncClient<Schema>;
  readonly subscriptionObserver: SubscriptionObserver;
  // Retained whole: the per-callback stores of `subscribeQueryIsolated` are
  // built from it, and rebuilding a `{ client }` literal there would silently drop
  // every other setting on the way in.
  private readonly config: RootStoreConfig<Schema>;

  constructor(config: RootStoreConfig<Schema>) {
    configureEntityMeta(config.client.schema);
    this.client = config.client;
    this.config = config;
    this.subscriptionObserver = config.subscriptionObserver ?? new ConsoleSubscriptionObserver();
    setDebugViewEnabled(config.debugView ?? false);
    this.hydrator = new ModelHydrator(this);
    this.initializeIdentityMaps();
    config.client.onTransactionDenied((denial) => { this.takeBack(denial); });
    if (config.onTransactionDenied) config.client.onTransactionDenied(reporterFor(config.onTransactionDenied));
    if (config.follow !== false) this.followReplica();
  }

  dispose(): void {
    this.stopFollowing?.();
    this.stopFollowing = null;
    this.closeSubscriptions();
  }

  /**
   * True once every model the first sync brought is in this store. Observable:
   * read it from an `observer` to hold back UI until the store has the data.
   */
  get synced(): boolean {
    return this.loaded.get();
  }

  /** Resolves once everything the server had received when asked is in this store's models. */
  async caughtUp(): Promise<void> {
    await this.client.caughtUp();
    await this.following;
  }

  private followReplica(): void {
    this.stopFollowing = this.client.onReplicaChanged((change) => {
      this.pendingChange.absorb(change);
      this.scheduleFollowPass();
    });
    this.enqueueFollowPass(async () => {
      await this.client.ready();
      await this.client.snapshot(async (read) => {
        const whole = await this.readWhole(read, this.followed(getEntityNames()));
        // Everything is read whole: whatever was reported so far is in it.
        this.pendingChange.clear();
        runInAction(() => {
          for (const [entity, rows] of whole) this.hydrateWhole(entity, rows);
          this.loaded.set(true);
        });
      });
    });
  }

  private scheduleFollowPass(): void {
    if (this.passScheduled) return;
    this.passScheduled = true;
    this.enqueueFollowPass(() => {
      this.passScheduled = false;
      return this.applyPendingChange();
    });
  }

  private enqueueFollowPass(pass: () => Promise<void>): void {
    this.following = this.following.then(pass).catch((error: unknown) => {
      this.subscriptionObserver.degraded({ label: "replica", message: error instanceof Error ? error.message : String(error) });
    });
  }

  // One pass applies every change reported by the time the gate read is held:
  // the replica may be several messages ahead of the models, and reading its
  // rows for one message's ids alone would show a row as a later message left
  // it without the rows that message brought. Under the read nothing more lands,
  // so what is pending is exactly the replica's lead, read as one state and
  // hydrated as one action.
  private async applyPendingChange(): Promise<void> {
    await this.client.snapshot(async (read) => {
      const change = this.pendingChange.take();
      if (change.isEmpty) return;
      const whole = await this.readWhole(read, this.followed(change.models().filter(isValidEntityName)));
      const written: [string, RawEntityData[]][] = [];
      for (const [entity, ids] of change.writtenIds()) {
        if (!isValidEntityName(entity) || !this.follows(entity)) continue;
        const result = await read(this.buildQueryWithRelationships({ [entity]: { where: { id: { in: ids } } } }));
        written.push([entity, toRawEntityArray(result[entity])]);
      }
      const removed = change.removedIds().filter(([entity]) => isValidEntityName(entity) && this.follows(entity));
      runInAction(() => {
        for (const [entity, rows] of whole) this.hydrateWhole(entity, rows);
        for (const [entity, rows] of written) this.hydrator.hydrateMany(entity, rows, this.getIdentityMapByName.bind(this));
        for (const [entity, ids] of removed) this.evictPersisted(entity, ids);
      });
    });
  }

  // A table nobody registered a class for (an auth provider's, say) is replicated
  // but has no models to keep in step; it is left out, and said so once.
  private followed(entities: readonly string[]): string[] {
    return entities.filter((entity) => this.follows(entity));
  }

  private follows(entity: string): boolean {
    if (isRegisteredModel(entity) || hasDiscriminatorMapping(entity)) return true;
    if (!this.notFollowed.has(entity)) {
      this.notFollowed.add(entity);
      this.subscriptionObserver.degraded({ label: "replica", message: `${entity} has no model class and is not followed` });
    }
    return false;
  }

  private async readWhole(read: (query: UntypedQuery) => Promise<QueryResult>, entities: readonly string[]): Promise<[string, RawEntityData[]][]> {
    const whole: [string, RawEntityData[]][] = [];
    for (const entity of entities) {
      const result = await read(this.buildQueryWithRelationships({ [entity]: {} }));
      whole.push([entity, toRawEntityArray(result[entity])]);
    }
    return whole;
  }

  // The model's rows as the replica holds all of them: models it no longer lists leave.
  private hydrateWhole(entity: string, rows: RawEntityData[]): void {
    this.hydrator.hydrateMany(entity, rows, this.getIdentityMapByName.bind(this));
    this.evictAbsent(entity, rows);
  }

  private evictPersisted(entity: string, ids: readonly string[]): void {
    const models = this.getIdentityMapByName(entity);
    for (const id of ids) {
      const model = models.get(id);
      if (model?.isPersisted) this.evictModel(model);
    }
  }

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
   * Runs `fn` as one transaction: auto-rollback if it throws, otherwise
   * applied locally and sent. See `TransactionHandle` for what the returned
   * promise and its `settled()` mean.
   */
  transaction<T>(fn: () => T | Promise<T>): TransactionHandle<T> {
    const applied = this.applyTransaction(fn);
    const settled = async (options: { signal?: AbortSignal } = {}): Promise<Settled<T>> => {
      const { result, transactionId } = await applied;
      const outcome = transactionId === null
        ? { transactionId: "", tick: null, status: "committed" as const, reason: null }
        : await this.client.verdict(transactionId, options);
      return { result, outcome };
    };
    return Object.assign(applied.then(({ result }) => result), { settled });
  }

  private async applyTransaction<T>(fn: () => T | Promise<T>): Promise<{ result: T; transactionId: string | null }> {
    const tx = this.createTransaction();
    let result: T;
    try {
      result = await TransactionContext.run(tx, fn);
    } catch (e) {
      tx.rollback();
      throw e;
    }
    return { result, transactionId: await tx.commit() };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TransactionStoreAccess implementation
  // ─────────────────────────────────────────────────────────────────────────────

  private entityNameOf(EntityClass: ModelClass): string {
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
        if (linkAttr.type !== deletedEntityType) continue;

        for (const model of identityMap.values()) {
          const fieldValue = readField(model, fieldName);

          if (!linkAttr.array) {
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

  /** A denied transaction's rows, back from the server: the models follow the replica. */
  private takeBack(denial: TransactionEffect): void {
    this.hydrateResult(denial.rows);
    for (const [entityName, ids] of Object.entries(denial.removed)) {
      if (!isValidEntityName(entityName)) continue;
      const identityMap = this.getIdentityMapByName(entityName);
      for (const id of ids) {
        const model = identityMap.get(id);
        if (model) this.evictModel(model);
      }
    }
  }

  evictModel(model: Model): void {
    withHydration(() => {
      runInAction(() => {
        this.cleanupRelationships(model.entityName, model);
        this.getIdentityMapByName(model.entityName).delete(model.id);
      });
    });
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

  getAllModels(): Model[] {
    const result: Model[] = [];
    for (const map of this.identityMaps.values()) {
      for (const entity of map.values()) {
        result.push(entity);
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
  /** This device's place in the presence room of one row of `EntityClass`: who else is there, and in what state. */
  presence(EntityClass: ModelClass, id: string): PresenceRoom {
    return this.client.presence(this.entityNameOf(EntityClass), id);
  }

  async queryModel<T extends Model>(
    EntityClass: ModelClass<T>
  ): Promise<T[]> {
    const entityName = this.entityNameOf(EntityClass);
    const query = this.buildQueryWithRelationships({ [entityName]: {} });
    const raw = await this.client.query(query);
    const rawDataArray = toRawEntityArray(raw[entityName]);

    const hydrated = this.hydrator.hydrateMany(
      entityName,
      rawDataArray,
      this.getIdentityMapByName.bind(this)
    );
    this.evictAbsent(entityName, rawDataArray);
    return hydrated.filter((m): m is T => isInstanceOf(m, EntityClass));
  }

  // A whole-table answer is authoritative: a persisted model it no longer
  // lists was removed, or hidden, while this store was not looking — a
  // tombstone may never have been shown. Models the server has not confirmed
  // yet are this store's own business and stay.
  private evictAbsent(entityName: string, rows: RawEntityData[]): void {
    const present = new Set(rows.map((row) => row.id));
    for (const model of [...this.getIdentityMapByName(entityName).values()]) {
      if (present.has(model.id) || !model.isPersisted) continue;
      this.evictModel(model);
    }
  }

  private createSubscription<T>(
    subscriptionKey: string,
    query: UntypedQuery,
    onData: (data: QueryResult) => T,
    callback?: (result: T) => void
  ): Promise<{ result: T; close: () => void }> {
    this.subscriptions.get(subscriptionKey)?.close();

    return new Promise((resolve, reject) => {
      let isFirstCallback = true;

      const unsubscribe = this.client.subscribe(
        query,
        ({ error, data }) => {
          if (error) {
            // No reconnect here: the transport supervises its own
            // reconnection. Only the reporting was missing.
            this.subscriptionObserver.degraded({
              label: subscriptionKey,
              message: error.message,
              ...(error.status === undefined ? {} : { status: error.status }),
            });
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
    const query = this.buildQueryWithRelationships({ [entityName]: {} });

    const { result: entities, close } = await this.createSubscription(
      entityName,
      query,
      (data): T[] => {
        const rawDataArray = toRawEntityArray(data[entityName]);
        const hydrated = this.hydrator.hydrateMany(
          entityName,
          rawDataArray,
          this.getIdentityMapByName.bind(this)
        );
        this.evictAbsent(entityName, rawDataArray);
        return hydrated.filter((m): m is T => isInstanceOf(m, EntityClass));
      },
      callback
    );

    return { entities, close };
  }

  private buildQueryWithRelationships(query: UntypedQuery): UntypedQuery {
    const expanded: UntypedQuery = {};
    for (const [entityName, args] of Object.entries(query)) {
      expanded[entityName] = isValidEntityName(entityName)
        ? this.expandFindArgs(entityName, args)
        : args;
    }
    return expanded;
  }

  // Hydration wires every link, so each one is fetched at least as ids;
  // links the caller asked for are expanded the same way, recursively.
  private expandFindArgs(entityName: string, args: Record<string, unknown>): Record<string, unknown> {
    const select = isRecord(args.select) ? args.select : undefined;
    const include = isRecord(args.include) ? args.include : undefined;
    const requested = select ?? include ?? {};
    const relations: Record<string, unknown> = {};
    for (const [fieldName, link] of Object.entries(getEntityLinks(entityName))) {
      const asked = requested[fieldName];
      relations[fieldName] = asked === undefined || asked === false
        ? { select: { id: true } }
        : this.expandFindArgs(link.type, isRecord(asked) ? asked : {});
    }
    if (select) {
      return { ...args, select: { ...select, id: true, ...relations } };
    }
    return { ...args, include: { ...include, ...relations } };
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

  private closeSubscriptions(): void {
    for (const sub of [...this.subscriptions.values()]) {
      sub.close();
    }
    this.subscriptions.clear();
  }

  async query(queryObj: SyncQuery<Schema>): Promise<void> {
    const expandedQuery = this.buildQueryWithRelationships(untypedQuery(queryObj));
    const raw = await this.client.query(expandedQuery);
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
  async subscribeQuery(
    queryObj: SyncQuery<Schema>,
    callback?: () => void
  ): Promise<{ close(): void }> {
    const expandedQuery = this.buildQueryWithRelationships(untypedQuery(queryObj));
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
    queryObj: SyncQuery<Schema>,
    handler: (store: RootStore<Schema>, prev: RootStore<Schema> | null) => Promise<void> | void,
    options: { label?: string } = {}
  ): Promise<{ close(): void }> {
    const expandedQuery = this.buildQueryWithRelationships(untypedQuery(queryObj));
    const label = options.label ?? "subscribeQueryIsolated";
    const config = this.config;

    // These outlive a reconnect on purpose. A re-opened subscription is a fresh
    // full snapshot, never a resumption, so a `prevStore` reset to null would
    // make every reactor keyed on "not in prev" reprocess its whole result set.
    let prevStore: RootStore<Schema> | null = null;
    let queue: Promise<void> = Promise.resolve();
    let closed = false;
    let firstResolved = false;
    let transport: { close(): void } | null = null;

    return new Promise<{ close(): void }>((resolve, reject) => {
      const close = () => {
        closed = true;
        transport?.close();
        const cleanup = () => {
          prevStore?.dispose();
          prevStore = null;
        };
        queue = queue.then(cleanup, cleanup);
      };

      const subscription = new ResilientSubscription<QuerySubscriptionState>({
        label,
        subscribe: (onPayload) => this.client.subscribe(expandedQuery, onPayload),
        readError: (payload) => payload.error,
        observer: this.subscriptionObserver,
      });

      transport = subscription.run(({ error, data }) => {
        if (closed) return;
        if (error) {
          // Only failures the supervisor is not handling itself arrive here: a
          // transient blip, or one that landed before the subscription ever
          // worked. The second must still fail the caller — booting a reactor
          // on a query that never connected is worse than not booting.
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
          const callbackStore = new RootStore<Schema>({ ...config, follow: false });
          try {
            callbackStore.hydrateResult(data);
            await handler(callbackStore, prevStore);
          } catch (err) {
            // Keep the old `prev`. Rotating it here would move the entities the
            // handler failed on into "already seen", and every reactor that
            // spots work by their absence from `prev` would skip them forever.
            this.subscriptionObserver.handlerFailed({ label, error: err });
            callbackStore.dispose();
            return;
          }
          prevStore?.dispose();
          prevStore = callbackStore;
        });

        if (!firstResolved) {
          firstResolved = true;
          resolve({ close });
        }
      });

      if (closed) transport.close();
    });
  }

}
