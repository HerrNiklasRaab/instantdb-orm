import type { EntityName } from "./store/EntityMeta";
import {
  initializeTracking,
  saveEntity,
  getTracker,
} from "./persistence/EntityPersistence";

export abstract class Model {
  abstract readonly id: string;
  abstract deletedAt: Date | null;

  get entityName(): EntityName {
    const className = this.constructor.name;
    if (className.startsWith("$")) {
      return ("$" + className.slice(1).toLowerCase() + "s") as EntityName;
    }
    return (className.toLowerCase() + "s") as EntityName;
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
