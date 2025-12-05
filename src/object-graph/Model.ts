import { type EntityName } from "./store/EntityMeta";
import { ChangeTracker } from "./persistence/ChangeTracker";
import { ENTITY_NAME_KEY, deriveEntityName } from "./decorators/model-utils";
import { makeObservable, observable } from "mobx";

export abstract class Model {
  readonly id: string;

  // Automatic timestamp fields (managed by the framework)
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null = null;

  private __tracker: ChangeTracker | null = null;

  constructor(id?: string) {
    this.id = id ?? crypto.randomUUID();
    const now = new Date();
    this.createdAt = now;
    this.updatedAt = now;
    makeObservable(this, {
      createdAt: observable,
      updatedAt: observable,
      deletedAt: observable,
    });
  }

  /**
   * Call at end of leaf class constructor to start tracking changes.
   * Must be called AFTER makeObservable() and all field initialization.
   */
  protected initTracking(): void {
    if (!this.__tracker) {
      this.__tracker = new ChangeTracker(this, this.entityName);
    }
  }

  /** @internal - Access tracker (creates lazily if not initialized) */
  get _tracker(): ChangeTracker {
    if (!this.__tracker) {
      this.__tracker = new ChangeTracker(this, this.entityName);
    }
    return this.__tracker;
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
    return this._tracker.hasChanges();
  }
}
