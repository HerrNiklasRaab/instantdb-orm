import { v4 as uuidv4 } from "uuid";
import { type EntityName, getEntityMeta } from "./store/EntityMeta";
import { ChangeTracker } from "./persistence/ChangeTracker";
import { ENTITY_NAME_KEY, deriveEntityName } from "./decorators/model-utils";
import { makeObservable as mobxMakeObservable, observable, reaction } from "mobx";
import { field } from "./decorators";
import { TransactionContext } from "./persistence/TransactionContext";

export abstract class Model {
  readonly id: string;

  @field()
  private readonly _createdAt: Date;

  @field()
  private _updatedAt: Date;

  @field()
  private _deletedAt: Date | null = null;

  _tracker: ChangeTracker | null = null;

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

  /** Sets updatedAt timestamp to now. Called by RootStore/Transaction before save. */
  setUpdatedAt(): void {
    this._updatedAt = new Date();
  }

  get deletedAt(): Date | null {
    return this._deletedAt;
  }

  /** Marks this model as deleted locally. Call store.save() to persist. */
  markDeleted(): void {
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
   * Sets up observables and starts tracking changes.
   * Public so hydrator can call it after creating instance via createForHydration().
   */
  initTracking(isNew: boolean = true): void {
    this.makeObservable();
    this._tracker = new ChangeTracker(this, this.entityName, isNew);
    this.setupDebugView();
    if (isNew) {
      TransactionContext.current?.registerNew(this);
    }
  }

  private setupDebugView(): void {
    const meta = getEntityMeta(this.entityName);
    const record = this as unknown as Record<string, unknown>;

    this._debugViewDisposer = reaction(
      () => {
        const values: unknown[] = [];
        // Track scalars
        for (const field of meta.scalarFields) {
          const propName = field.getFieldNameOnModel(this);
          values.push(record[propName]);
        }
        // Track relationships (reference identity)
        for (const rel of meta.relationshipFields) {
          const propName = rel.getFieldNameOnModel(this);
          values.push(record[propName]);
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
    const record = this as unknown as Record<string, unknown>;
    const snapshot: Record<string, unknown> = { id: this.id };

    // Scalars - serialize dates to ISO strings
    for (const field of meta.scalarFields) {
      const propName = field.getFieldNameOnModel(this);
      const value = record[propName];

      if (value instanceof Date) {
        snapshot[field.fieldName] = value.toISOString();
      } else {
        snapshot[field.fieldName] = value;
      }
    }

    // Relationships - keep as live Model references for expandable debugging
    for (const rel of meta.relationshipFields) {
      const propName = rel.getFieldNameOnModel(this);
      snapshot[rel.fieldName] = record[propName];
    }

    return snapshot;
  }

  get entityName(): EntityName {
    // Read from decorator-stored value, fallback to derivation
    const stored = (this.constructor as any)[ENTITY_NAME_KEY];
    if (stored) {
      return stored as EntityName;
    }
    // Fallback for classes without @model decorator
    return deriveEntityName(this.constructor.name) as EntityName;
  }

  isDirty(): boolean {
    return this._tracker!.hasChanges();
  }

  get isNew(): boolean {
    return this._tracker!.isNew;
  }
}
