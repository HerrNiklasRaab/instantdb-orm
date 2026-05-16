import type { Model } from "../Model";
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

  constructor(model: Model) {
    const entityName = model.entityName;
    const meta = getEntityMeta(entityName);
    const record = model as unknown as Record<string, unknown>;

    for (const field of meta.scalarFields) {
      const propName = field.getFieldNameOnModel(model);
      this.scalars.set(field.fieldName, record[propName]);
    }

    for (const rel of meta.relationshipFields) {
      const propName = rel.getFieldNameOnModel(model);
      const value = record[propName];

      if (rel.isToOne()) {
        const modelRef = value as Model | null;
        this.relationships.set(rel.fieldName, modelRef?.id ?? null);
      } else {
        const models = (value as Model[] | undefined) ?? [];
        this.relationships.set(rel.fieldName, models.map((m) => m.id));
      }
    }
  }

  static emptyOriginal(): ModelSnapshot {
    return Object.create(ModelSnapshot.prototype, {
      scalars: { value: new Map(), enumerable: true },
      relationships: { value: new Map(), enumerable: true },
    }) as ModelSnapshot;
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
