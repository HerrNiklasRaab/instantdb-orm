import { type EntityName } from "./store/EntityMeta";
import { ChangeTracker } from "./persistence/ChangeTracker";
import { ENTITY_NAME_KEY, deriveEntityName } from "./decorators/model-utils";

export abstract class Model {
  abstract readonly id: string;
  abstract deletedAt: Date | null;

  /** @internal Tracks changes for persistence (lazy initialized) */
  private _trackerInstance: ChangeTracker | null = null;

  /** @internal Force tracker initialization (call after makeObservable) */
  _initTracker(): void {
    void this._tracker;
  }

  /** @internal */
  get _tracker(): ChangeTracker {
    if (!this._trackerInstance) {
      this._trackerInstance = new ChangeTracker(this, this.entityName);
    }
    return this._trackerInstance;
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
