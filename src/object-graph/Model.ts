import { type EntityName } from "./store/EntityMeta";
import { ChangeTracker } from "./persistence/ChangeTracker";
import { ENTITY_NAME_KEY, deriveEntityName } from "./decorators/model-utils";
import { makeObservable as mobxMakeObservable, observable } from "mobx";

export abstract class Model {
  readonly id: string;

  // Automatic timestamp fields (managed by the framework)
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null = null;

  _tracker: ChangeTracker | null = null;

  constructor(id?: string) {
    this.id = id ?? crypto.randomUUID();
    const now = new Date();
    this.createdAt = now;
    this.updatedAt = now;
  }

  /**
   * Override in subclasses to register observable fields.
   * Always call super.makeObservable() first.
   */
  protected makeObservable(): void {
    mobxMakeObservable(this, {
      createdAt: observable,
      updatedAt: observable,
      deletedAt: observable,
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
}
