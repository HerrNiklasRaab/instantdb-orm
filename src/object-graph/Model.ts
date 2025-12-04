import { getEntityMeta, type EntityName } from "./store/EntityMeta";
import type { RootStore } from "./store/RootStore";
import { ChangeTracker } from "./persistence/ChangeTracker";
import type { TxChunk } from "./persistence/types";
import { ENTITY_NAME_KEY, deriveEntityName } from "./decorators/model";

export abstract class Model {
  abstract readonly id: string;
  abstract deletedAt: Date | null;

  /** @internal Set during construction or registration */
  _store: RootStore | null;
  /** @internal Tracks changes for persistence (lazy initialized) */
  private _trackerInstance: ChangeTracker | null = null;

  constructor(store: RootStore | null = null) {
    this._store = store;
  }

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

  async save(): Promise<void> {
    if (!this._store) {
      throw new Error(`Model ${this.entityName}:${this.id} has no store. Use store.create() to create entities.`);
    }

    if (!this._tracker.hasChanges()) {
      return;
    }

    const db = this._store.db;
    const entityName = this.entityName;
    const changes = this._tracker.getChanges();
    let tx: TxChunk = db.tx[entityName][this.id];

    // Scalar updates
    if (changes.scalars.size > 0) {
      const updateData: Record<string, unknown> = {};
      for (const [field, value] of changes.scalars) {
        updateData[field] = value instanceof Date ? value.toISOString() : value;
      }
      tx = tx.update(updateData);
    }

    // Link operations
    for (const [linkName, ids] of changes.links) {
      const label = this.getLinkLabel(entityName, linkName);
      tx = tx.link({ [label]: ids.length === 1 ? ids[0] : ids });
    }

    // Unlink operations
    for (const [linkName, ids] of changes.unlinks) {
      const label = this.getLinkLabel(entityName, linkName);
      tx = tx.unlink({ [label]: ids.length === 1 ? ids[0] : ids });
    }

    await db.transact([tx]);
    this._tracker.reset();
  }

  isDirty(): boolean {
    return this._tracker.hasChanges();
  }

  async delete(): Promise<void> {
    this.deletedAt = new Date();
    await this.save();
  }

  private getLinkLabel(entityName: EntityName, linkName: string): string {
    const meta = getEntityMeta(entityName);
    const rel = meta.relationshipFields.find((r) => r.linkName === linkName);
    return rel?.fieldName ?? linkName;
  }
}
