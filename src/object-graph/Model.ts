import { v4 as uuidv4 } from "uuid";
import {
  type EntityName,
  getEntityAttrs,
  getEntityLinks,
  getFieldNameOnModel,
  readField,
} from "./store/EntityMeta";
import { ENTITY_NAME_KEY, deriveEntityName } from "./decorators/model-utils";
import {
  makeObservable as mobxMakeObservable,
  observable,
  observe,
  intercept,
  reaction,
} from "mobx";
import { field, inMemory, applyInMemoryDefaults } from "./decorators";
import { Temporal } from "./temporal";
import { fieldsForModel } from "./store/fieldsForEntity";
import { TransactionContext } from "./persistence/TransactionContext";
import type { ClaimRecord } from "./persistence/ScopedTransaction";
import { wireReverseLink, isWiringInProgress, withConstructorSweep } from "./store/reverseLinkWiring";
import { isHydrationInProgress } from "./store/hydrationContext";

/**
 * Global flag for the per-Model `debugView` snapshot. Off by default; flipped
 * on by `RootStore` when constructed with `{ debugView: true }`. Keeping it
 * module-level lets Model constructors check it without needing a store
 * reference at construction time.
 */
let debugViewEnabled = false;

export function setDebugViewEnabled(enabled: boolean): void {
  debugViewEnabled = enabled;
}

/**
 * Copy-safe "is this a Model?" check. `instanceof Model` compares against the
 * `Model` class of the *current* bundle copy, but Next/turbopack loads many
 * copies of this package — a model built by one copy fails `instanceof` against
 * another copy's `Model`. The brand is keyed by `Symbol.for`, so every copy
 * stamps the same key on its `Model.prototype` and the check holds across
 * copies. (Subclass identity still goes through the registry — see RootStore.)
 */
const MODEL_BRAND = Symbol.for("@upfor/sync.Model");

export function isModel(value: unknown): value is Model {
  return value !== null && typeof value === "object" && MODEL_BRAND in value;
}

export enum ModelLifecycle {
  Transient = "transient",
  PendingNew = "pendingNew",
  Persisted = "persisted",
  HardDeleted = "hardDeleted",
}

export abstract class Model {
  readonly id: string;

  @field({ type: Temporal.Instant })
  private readonly _createdAt: Temporal.Instant;

  @field({ type: Temporal.Instant })
  private _updatedAt: Temporal.Instant;

  @field({ type: Temporal.Instant, optional: true })
  private _deletedAt: Temporal.Instant | null = null;

  /**
   * MobX observer/interceptor disposers. `null` before `initTracking` runs —
   * a signal that reverse-link wiring uses to defer until the model is fully
   * constructed.
   */
  _disposers: (() => void)[] | null = null;

  /**
   * Active claim records from in-flight transactions that have touched this
   * model. Read by `ModelHydrator` (and `isFieldTouched`) to decide whether
   * a remote update should overwrite a given field. `null` when no tx is
   * currently editing the model.
  */
  _activeClaims: Set<ClaimRecord> | null = null;

  @inMemory(ModelLifecycle.Transient)
  private _lifecycle: ModelLifecycle = ModelLifecycle.Transient;

  /**
   * Plain JS snapshot for debugging. Auto-updates via MobX reaction.
   * Workaround for bun debugger not displaying MobX observables: https://github.com/oven-sh/bun/issues/25517
   */
  debugView: Record<string, unknown> | null = null;
  private _debugViewDisposer: (() => void) | null = null;

  constructor(id?: string) {
    this.id = id ?? uuidv4();
    this._createdAt = Temporal.Now.instant();
    this._updatedAt = Temporal.Now.instant();
  }

  get createdAt(): Temporal.Instant {
    return this._createdAt;
  }

  get updatedAt(): Temporal.Instant {
    return this._updatedAt;
  }

  /** Sets updatedAt timestamp to now. Called by ScopedTransaction.commit before flushing. */
  setUpdatedAt(): void {
    this._updatedAt = Temporal.Now.instant();
  }

  get deletedAt(): Temporal.Instant | null {
    return this._deletedAt;
  }

  softDelete(): void {
    this._deletedAt = Temporal.Now.instant();
  }

  delete(): void {
    const tx = this.currentMutationTransaction();
    if (!tx) return;
    if (this._lifecycle !== ModelLifecycle.Persisted) {
      throw new Error(`Cannot delete ${this.entityName} ${this.id}; model is ${this._lifecycle}.`);
    }
    if (this._deletedAt === null) {
      this._deletedAt = Temporal.Now.instant();
    }
    tx.deleteModel(this);
  }

  /**
   * Override in subclasses to register observable fields.
   * Always call super.makeObservable() first.
   */
  protected makeObservable(): void {
    mobxMakeObservable<Model, "_createdAt" | "_updatedAt" | "_deletedAt">(this, {
      _createdAt: observable.ref,
      _updatedAt: observable.ref,
      _deletedAt: observable.ref,
      debugView: false,
    });
  }

  /**
   * Call at end of leaf class constructor to finalize the model.
   * Sets up observables and starts the reverse-link wiring + tx-claim
   * observers. Public so hydrator can call it after creating instance via
   * createForHydration().
   */
  initTracking(lifecycle: ModelLifecycle = ModelLifecycle.Transient): void {
    applyInMemoryDefaults(this);
    this.makeObservable();
    const disposers: (() => void)[] = [];
    this._disposers = disposers;
    this.setupObservers(disposers);
    this.setupDebugView();
    switch (lifecycle) {
      case ModelLifecycle.Transient:
        this._lifecycle = ModelLifecycle.Transient;
        TransactionContext.current?.registerNew(this);
        this.wireConstructorRelationships();
        return;
      case ModelLifecycle.Persisted:
        this._lifecycle = ModelLifecycle.Persisted;
        return;
      case ModelLifecycle.PendingNew:
        throw new Error("Use ScopedTransaction.registerNew to create pending-new models.");
      case ModelLifecycle.HardDeleted:
        throw new Error("Cannot initialize a hard-deleted model.");
    }
  }

  /** Dispose all observers/interceptors. */
  disposeTracking(): void {
    for (const disposer of this._disposers ?? []) {
      disposer();
    }
    this._disposers = null;
    this._debugViewDisposer?.();
    this._debugViewDisposer = null;
  }

  /** True if any active transaction has marked `fieldName` as user-touched. */
  isFieldTouched(fieldName: string): boolean {
    if (!this._activeClaims) return false;
    for (const claim of this._activeClaims) {
      if (claim.touched.has(fieldName)) return true;
    }
    return false;
  }

  _adoptAsPendingNew(): boolean {
    if (this._lifecycle === ModelLifecycle.Persisted) return false;
    if (this._lifecycle === ModelLifecycle.PendingNew) return false;
    if (this._disposers == null) return false;
    this._lifecycle = ModelLifecycle.PendingNew;
    return true;
  }

  _persistPendingNew(): void {
    this.assertPendingNewLifecycle("persist");
    this._lifecycle = ModelLifecycle.Persisted;
  }

  _discardPendingNew(): void {
    this.assertPendingNewLifecycle("discard");
    this._lifecycle = ModelLifecycle.Transient;
  }

  _markHardDeleted(): void {
    this._lifecycle = ModelLifecycle.HardDeleted;
  }

  private assertPendingNewLifecycle(action: string): void {
    if (this._lifecycle === ModelLifecycle.PendingNew) return;
    throw new Error(`Cannot ${action} ${this.entityName} ${this.id}; model is ${this._lifecycle}.`);
  }

  private setupObservers(disposers: (() => void)[]): void {
    const links = getEntityLinks(this.entityName);

    const propToFieldName = new Map<string, string>();
    const relationshipPropToFieldName = new Map<string, string>();
    const toOneRelByProp = new Map<string, string>();
    for (const field of fieldsForModel(this.constructor, this.entityName)) {
      // Map the mutated property → its claim key (the schema-facing
      // attributeName): a backing field like `_name` claims column `name`; a
      // composed field claims its own prefix. Claims, snapshots, and rollback
      // all key by attributeName.
      propToFieldName.set(field.propertyName, field.attributeName);
    }
    for (const [fieldName, linkAttr] of Object.entries(links)) {
      if (fieldName === "id") continue;
      const propName = getFieldNameOnModel(this, fieldName);
      propToFieldName.set(propName, fieldName);
      relationshipPropToFieldName.set(propName, fieldName);
      if (linkAttr.cardinality === "one") {
        toOneRelByProp.set(propName, fieldName);
      }
    }

    try {
      const interceptDisposer = intercept(this as object, (change) => {
        if (typeof change.name === "string") {
          const fieldName = propToFieldName.get(change.name);
          if (fieldName !== undefined) {
            const relFieldName = relationshipPropToFieldName.get(change.name);
            if (relFieldName !== undefined) {
              const newValue: unknown = change.type === "remove" ? undefined : change.newValue;
              this.trackRelationshipMutation(relFieldName, isModel(newValue) ? [newValue] : []);
            } else {
              this.claimScalarForCurrentTransaction(fieldName);
            }
          }
        }
        return change;
      });
      disposers.push(interceptDisposer);
    } catch {
      // Object might not be observable, skip
    }

    try {
      const observeDisposer = observe(this as object, (change) => {
        if (change.type !== "update") return;
        if (typeof change.name !== "string") return;
        const relFieldName = toOneRelByProp.get(change.name);
        if (relFieldName === undefined) return;
        const oldVal: unknown = change.oldValue;
        const newVal: unknown = change.newValue;
        if (isModel(oldVal) && oldVal !== newVal) {
          wireReverseLink(this, oldVal, relFieldName, false);
        }
        if (isModel(newVal) && oldVal !== newVal) {
          wireReverseLink(this, newVal, relFieldName, true);
        }
      });
      disposers.push(observeDisposer);
    } catch {
      // Object might not be observable, skip
    }

    for (const [fieldName, linkAttr] of Object.entries(links)) {
      if (fieldName === "id") continue;
      if (linkAttr.cardinality !== "many") continue;
      const relFieldName = fieldName;
      const rawArray: unknown = readField(this, fieldName);
      if (!Array.isArray(rawArray)) continue;
      const arrayObservable: unknown[] = rawArray;
      const members = new Set<Model>();
      for (const item of arrayObservable) {
        if (isModel(item)) members.add(item);
      }

      try {
        const disposer = observe(arrayObservable, (change) => {
          if (change.type === "splice") {
            for (const added of change.added) {
              if (isModel(added)) wireReverseLink(this, added, relFieldName, true);
            }
            for (const removed of change.removed) {
              if (isModel(removed)) wireReverseLink(this, removed, relFieldName, false);
            }
          }
        });
        disposers.push(disposer);
      } catch {
        // Array might not be observable, skip it
      }
      try {
        const interceptDisposer = intercept(arrayObservable, (change) => {
          if (change.type === "splice") {
            const removedItems: Model[] = [];
            if (change.removedCount > 0) {
              for (let i = 0; i < change.removedCount; i++) {
                const removedItem: unknown = arrayObservable[change.index + i];
                if (isModel(removedItem)) removedItems.push(removedItem);
              }
            }
            const filteredAdded: Model[] = [];
            if (change.added.length > 0) {
              for (const item of change.added) {
                if (isModel(item) && !members.has(item)) {
                  filteredAdded.push(item);
                }
              }
              if (filteredAdded.length === 0 && change.removedCount === 0) {
                return null;
              }
              change.added = filteredAdded;
            } else if (change.removedCount === 0) {
              return null;
            }
            this.trackRelationshipMutation(relFieldName, filteredAdded);
            for (const removedItem of removedItems) {
              members.delete(removedItem);
            }
            for (const addedItem of filteredAdded) {
              members.add(addedItem);
            }
          } else {
            this.trackRelationshipMutation(
              relFieldName,
              isModel(change.newValue) ? [change.newValue] : []
            );
          }
          return change;
        });
        disposers.push(interceptDisposer);
      } catch {
        // Array might not be observable, skip it
      }
    }
  }

  private currentMutationTransaction(): typeof TransactionContext.current {
    // Skip claims that originate from reverse-link wiring. The wirer's
    // mutation on the wired side is bookkeeping (the forward-side row's
    // `link` op is what InstantDB persists), so the wired side should not
    // be drawn into the active transaction's commit.
    if (isWiringInProgress()) return null;
    // Hydration writes scalars and relationships through MobX-observed
    // properties; those mutations are framework-internal, not user intent.
    if (isHydrationInProgress()) return null;
    const tx = TransactionContext.current;
    if (!tx) {
      throw new Error(
        `Cannot mutate ${this.entityName} ${this.id} outside of a transaction. ` +
        `Wrap the mutation in store.transaction(() => ...).`
      );
    }
    return tx;
  }

  private claimScalarForCurrentTransaction(fieldName: string): void {
    const tx = this.currentMutationTransaction();
    if (!tx) return;
    if (this._lifecycle === ModelLifecycle.PendingNew) return;
    if (this._lifecycle === ModelLifecycle.HardDeleted) {
      throw new Error(`Cannot mutate hard-deleted ${this.entityName} ${this.id}.`);
    }
    if (this._lifecycle === ModelLifecycle.Transient) {
      throw new Error(
        `Cannot mutate transient ${this.entityName} ${this.id} field "${fieldName}" inside a transaction before attaching it through a relationship.`
      );
    }
    tx.claim(this, fieldName);
  }

  private trackRelationshipMutation(fieldName: string, relatedModels: readonly Model[]): void {
    const tx = this.currentMutationTransaction();
    if (!tx) return;
    if (this._lifecycle === ModelLifecycle.HardDeleted) {
      throw new Error(`Cannot mutate hard-deleted ${this.entityName} ${this.id}.`);
    }
    tx.adopt(this);
    for (const model of relatedModels) {
      tx.adopt(model);
    }
    if (this._lifecycle !== ModelLifecycle.PendingNew) {
      tx.claim(this, fieldName);
    }
  }

  /**
   * One-shot reverse-link wiring for relationships set in the constructor
   * (before observables existed). Walks current relationship values and
   * pushes them to the reverse side. The observers handle later mutations.
   *
   * Bracketed by `withConstructorSweep` so the wirer skips writing back to
   * any mid-construction owner reached from here (their own constructors
   * will populate themselves).
   */
  private wireConstructorRelationships(): void {
    withConstructorSweep(() => {
      const links = getEntityLinks(this.entityName);
      for (const [fieldName, linkAttr] of Object.entries(links)) {
        const value = readField(this, fieldName);
        if (linkAttr.cardinality === "one") {
          if (isModel(value)) wireReverseLink(this, value, fieldName, true);
        } else if (Array.isArray(value)) {
          for (const child of value) {
            if (isModel(child)) wireReverseLink(this, child, fieldName, true);
          }
        }
      }
    });
  }

  private setupDebugView(): void {
    if (!debugViewEnabled) return;
    const attrs = getEntityAttrs(this.entityName);
    const links = getEntityLinks(this.entityName);

    this._debugViewDisposer = reaction(
      () => {
        const values: unknown[] = [];
        for (const fieldName of Object.keys(attrs)) {
          values.push(readField(this, fieldName));
        }
        for (const fieldName of Object.keys(links)) {
          values.push(readField(this, fieldName));
        }
        return values;
      },
      () => {
        this.debugView = this.buildDebugViewSnapshot();
      },
      { fireImmediately: true }
    );
  }

  private buildDebugViewSnapshot(): Record<string, unknown> {
    const links = getEntityLinks(this.entityName);
    const snapshot: Record<string, unknown> = { id: this.id };

    // Columns through the same codec path persistence uses, so values come out
    // already serialized (Temporal → readable ISO string) — no separate
    // display conversion.
    const scalars = new Map<string, unknown>();
    for (const field of fieldsForModel(this.constructor, this.entityName)) {
      field.captureSnapshot(this, "", scalars);
    }
    for (const [column, value] of scalars) {
      snapshot[column] = value;
    }

    for (const fieldName of Object.keys(links)) {
      snapshot[fieldName] = readField(this, fieldName);
    }

    return snapshot;
  }

  get entityName(): EntityName {
    const stored: unknown = Reflect.get(this.constructor, ENTITY_NAME_KEY);
    if (typeof stored === "string") {
      return stored;
    }
    return deriveEntityName(this.constructor.name);
  }
}

Object.defineProperty(Model.prototype, MODEL_BRAND, { value: true });
