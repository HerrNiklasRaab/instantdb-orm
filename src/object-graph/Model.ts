import { type EntityName } from "./store/EntityMeta";
import { ChangeTracker } from "./persistence/ChangeTracker";
import { ENTITY_NAME_KEY, deriveEntityName } from "./decorators/model-utils";

export abstract class Model {
  readonly id: string;
  abstract deletedAt: Date | null;

  private __tracker: ChangeTracker | null = null;

  constructor(id?: string) {
    this.id = id ?? crypto.randomUUID();
  }

  /** @internal - Lazily creates tracker on first access */
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
