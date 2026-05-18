import { v4 as uuidv4 } from "uuid";
import { type EntityName, getEntityMeta, RelationshipFieldMeta } from "./store/EntityMeta";
import { ENTITY_NAME_KEY, deriveEntityName } from "./decorators/model-utils";
import {
  makeObservable as mobxMakeObservable,
  observable,
  observe,
  intercept,
  reaction,
} from "mobx";
import { field } from "./decorators";
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

export abstract class Model {
  readonly id: string;

  @field()
  private readonly _createdAt: Date;

  @field()
  private _updatedAt: Date;

  @field()
  private _deletedAt: Date | null = null;

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

  /**
   * Plain JS snapshot for debugging. Auto-updates via MobX reaction.
   * Workaround for bun debugger not displaying MobX observables: https://github.com/oven-sh/bun/issues/25517
   */
  debugView: Record<string, unknown> | null = null;
  private _debugViewDisposer: (() => void) | null = null;

  constructor(id?: string) {
    this.id = id ?? uuidv4();
    this._createdAt = new Date();
    this._updatedAt = new Date();
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Sets updatedAt timestamp to now. Called by ScopedTransaction.commit before flushing. */
  setUpdatedAt(): void {
    this._updatedAt = new Date();
  }

  get deletedAt(): Date | null {
    return this._deletedAt;
  }

  /**
   * Soft-delete this model. Stamps `deletedAt`; the surrounding transaction
   * commits it.
   */
  delete(): void {
    this._deletedAt = new Date();
  }

  /**
   * Override in subclasses to register observable fields.
   * Always call super.makeObservable() first.
   */
  protected makeObservable(): void {
    mobxMakeObservable<Model, "_createdAt" | "_updatedAt" | "_deletedAt">(this, {
      _createdAt: observable,
      _updatedAt: observable,
      _deletedAt: observable,
      debugView: false,
    });
  }

  /**
   * Call at end of leaf class constructor to finalize the model.
   * Sets up observables and starts the reverse-link wiring + tx-claim
   * observers. Public so hydrator can call it after creating instance via
   * createForHydration().
   */
  initTracking(isNew: boolean = true): void {
    this.makeObservable();
    const disposers: (() => void)[] = [];
    this._disposers = disposers;
    this.setupObservers(disposers);
    this.setupDebugView();
    if (isNew) {
      TransactionContext.current?.registerNew(this);
      this.wireConstructorRelationships();
    }
  }

  /** Dispose all observers/interceptors. Called by ScopedTransaction.rollback for new models. */
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

  private setupObservers(disposers: (() => void)[]): void {
    const meta = getEntityMeta(this.entityName);

    const propToFieldName = new Map<string, string>();
    const toOneRelByProp = new Map<string, RelationshipFieldMeta>();
    for (const field of meta.fields) {
      if (field.fieldName === "id") continue;
      const propName = field.getFieldNameOnModel(this);
      propToFieldName.set(propName, field.fieldName);
      if (field instanceof RelationshipFieldMeta && field.isToOne()) {
        toOneRelByProp.set(propName, field);
      }
    }

    try {
      const interceptDisposer = intercept(this as object, (change) => {
        if (typeof change.name === "string") {
          const fieldName = propToFieldName.get(change.name);
          if (fieldName !== undefined) {
            this.claimForCurrentTransaction(fieldName);
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
        const rel = toOneRelByProp.get(change.name);
        if (!rel) return;
        const oldVal: unknown = change.oldValue;
        const newVal: unknown = change.newValue;
        if (oldVal instanceof Model && oldVal !== newVal) {
          wireReverseLink(this, oldVal, rel, false);
        }
        if (newVal instanceof Model && oldVal !== newVal) {
          wireReverseLink(this, newVal, rel, true);
        }
      });
      disposers.push(observeDisposer);
    } catch {
      // Object might not be observable, skip
    }

    for (const field of meta.fields) {
      if (field.fieldName === "id") continue;
      if (!(field instanceof RelationshipFieldMeta) || !field.isToMany()) continue;
      const rel = field;
      const relFieldName = rel.fieldName;
      const rawArray: unknown = rel.read(this);
      if (!Array.isArray(rawArray)) continue;
      const arrayObservable = rawArray;
      const members = new Set<Model>();
      for (const item of arrayObservable) {
        if (item instanceof Model) members.add(item);
      }

      try {
        const disposer = observe(arrayObservable, (change) => {
          if (change.type === "splice") {
            for (const added of change.added) {
              if (added instanceof Model) wireReverseLink(this, added, rel, true);
            }
            for (const removed of change.removed) {
              if (removed instanceof Model) wireReverseLink(this, removed, rel, false);
            }
          }
        });
        disposers.push(disposer);
      } catch {
        // Array might not be observable, skip it
      }
      try {
        const interceptDisposer = intercept(arrayObservable, (change) => {
          this.claimForCurrentTransaction(relFieldName);
          if (change.type === "splice") {
            if (change.removedCount > 0) {
              for (let i = 0; i < change.removedCount; i++) {
                const removedItem: unknown = arrayObservable[change.index + i];
                if (removedItem instanceof Model) members.delete(removedItem);
              }
            }
            if (change.added.length > 0) {
              const filteredAdded: Model[] = [];
              for (const item of change.added) {
                if (item instanceof Model && !members.has(item)) {
                  members.add(item);
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
          }
          return change;
        });
        disposers.push(interceptDisposer);
      } catch {
        // Array might not be observable, skip it
      }
    }
  }

  private claimForCurrentTransaction(fieldName: string): void {
    // Skip claims that originate from reverse-link wiring. The wirer's
    // mutation on the wired side is bookkeeping (the forward-side row's
    // `link` op is what InstantDB persists), so the wired side should not
    // be drawn into the active transaction's commit.
    if (isWiringInProgress()) return;
    // Hydration writes scalars and relationships through MobX-observed
    // properties; those mutations are framework-internal, not user intent.
    if (isHydrationInProgress()) return;
    const tx = TransactionContext.current;
    if (!tx) {
      throw new Error(
        `Cannot mutate ${this.entityName} ${this.id} outside of a transaction. ` +
        `Wrap the mutation in store.transaction(() => ...).`
      );
    }
    tx.claim(this, fieldName);
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
      const meta = getEntityMeta(this.entityName);
      for (const rel of meta.relationshipFields) {
        const value = rel.read(this);
        if (rel.isToOne()) {
          if (value instanceof Model) wireReverseLink(this, value, rel, true);
        } else if (Array.isArray(value)) {
          for (const child of value) {
            if (child instanceof Model) wireReverseLink(this, child, rel, true);
          }
        }
      }
    });
  }

  private setupDebugView(): void {
    if (!debugViewEnabled) return;
    const meta = getEntityMeta(this.entityName);

    this._debugViewDisposer = reaction(
      () => {
        const values: unknown[] = [];
        for (const field of meta.scalarFields) {
          values.push(field.read(this));
        }
        for (const rel of meta.relationshipFields) {
          values.push(rel.read(this));
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
    const meta = getEntityMeta(this.entityName);
    const snapshot: Record<string, unknown> = { id: this.id };

    for (const field of meta.scalarFields) {
      const value = field.read(this);
      snapshot[field.fieldName] = value instanceof Date ? value.toISOString() : value;
    }

    for (const rel of meta.relationshipFields) {
      snapshot[rel.fieldName] = rel.read(this);
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
