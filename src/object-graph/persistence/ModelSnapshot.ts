import { Model } from "../Model";
import { getEntityMeta } from "../store/EntityMeta";
import type { RawEntityData } from "../store/types";

/**
 * Captures a model's state at a point in time.
 * Used by ScopedTransaction for claim-time baselines, rollback restoration,
 * and as the empty baseline for new-model commit diffs.
 */
export class ModelSnapshot {
  readonly scalars = new Map<string, unknown>();
  readonly relationships = new Map<string, string | string[] | null>();

  constructor(model: Model | null = null) {
    if (model === null) return;
    const entityName = model.entityName;
    const meta = getEntityMeta(entityName);

    for (const field of meta.scalarFields) {
      this.scalars.set(field.fieldName, field.read(model));
    }

    for (const rel of meta.relationshipFields) {
      const value = rel.read(model);

      if (rel.isToOne()) {
        const id = value instanceof Model ? value.id : null;
        this.relationships.set(rel.fieldName, id);
      } else {
        const ids: string[] = [];
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item instanceof Model) ids.push(item.id);
          }
        }
        this.relationships.set(rel.fieldName, ids);
      }
    }
  }

  static emptyOriginal(): ModelSnapshot {
    return new ModelSnapshot(null);
  }

  toRawEntityData(id: string): RawEntityData {
    const data: RawEntityData = { id };

    for (const [fieldName, value] of this.scalars) {
      data[fieldName] = value instanceof Date ? value.toISOString() : value;
    }

    for (const [fieldName, value] of this.relationships) {
      if (value === null) {
        data[fieldName] = null;
      } else if (Array.isArray(value)) {
        data[fieldName] = value.map((relId) => ({ id: relId }));
      } else {
        data[fieldName] = [{ id: value }];
      }
    }

    return data;
  }
}
