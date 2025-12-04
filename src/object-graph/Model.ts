import { makeObservable } from "mobx";
import { type EntityName } from "./store/EntityMeta";
import { ChangeTracker } from "./persistence/ChangeTracker";
import { ENTITY_NAME_KEY, deriveEntityName } from "./decorators/model-utils";

export abstract class Model {
  abstract readonly id: string;
  abstract deletedAt: Date | null;

  /** @internal */
  _tracker: ChangeTracker | null = null;

  /** Call at end of subclass constructor after setting fields. Wraps makeObservable + tracker init. */
  protected init(annotations: Record<string, unknown>): void {
    makeObservable(this, annotations as never);
    this._tracker = new ChangeTracker(this, this.entityName);
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
