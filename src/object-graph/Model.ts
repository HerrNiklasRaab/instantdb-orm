import type { EntityName } from "./store/EntityMeta";
import {
  initializeTracking,
  saveEntity,
  getTracker,
} from "./persistence/EntityPersistence";
import { ENTITY_NAME_KEY, deriveEntityName } from "./decorators/model";

export abstract class Model {
  abstract readonly id: string;
  abstract deletedAt: Date | null;

  get entityName(): EntityName {
    // Read from decorator-stored value, fallback to derivation
    const stored = (this.constructor as any)[ENTITY_NAME_KEY];
    if (stored) {
      return stored as EntityName;
    }
    // Fallback for classes without @model decorator
    return deriveEntityName(this.constructor.name) as EntityName;
  }

  protected initializeTracking(): void {
    const entityName = this.entityName;
    queueMicrotask(() => {
      initializeTracking(this, entityName);
    });
  }

  async save(): Promise<void> {
    await saveEntity(this, this.entityName);
  }

  isDirty(): boolean {
    const tracker = getTracker(this);
    return tracker?.hasChanges() ?? false;
  }

  async delete(): Promise<void> {
    this.deletedAt = new Date();
    await this.save();
  }
}
