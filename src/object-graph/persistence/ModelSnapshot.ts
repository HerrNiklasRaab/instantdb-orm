import type { Model } from "../Model";
import { getEntityMeta } from "../store/EntityMeta";
import type { RawEntityData } from "../store/types";

/**
 * Captures a model's state at a point in time.
 * Used by Transaction for rollback and ChangeTracker for original state.
 */
export class ModelSnapshot {
  readonly scalars = new Map<string, unknown>();
  readonly relationships = new Map<string, string | string[] | null>();
  readonly wasNew: boolean;

  constructor(model: Model, wasNew?: boolean) {
    const entityName = model.entityName;
    const meta = getEntityMeta(entityName);
    const record = model as unknown as Record<string, unknown>;

    // Capture scalar values
    for (const field of meta.scalarFields) {
      const propName = field.getFieldNameOnModel(model);
      this.scalars.set(field.fieldName, record[propName]);
    }

    // Capture relationship IDs
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

    this.wasNew = wasNew ?? model._tracker?.isNew ?? true;
  }

  /**
   * Shallow copy of this snapshot. Use when capturing the live
   * `originalSnapshot` of a tracker for later restoration — its Map gets
   * mutated by `acceptRelationshipDelta`, so a reference would silently
   * change underneath the holder. Inner array values are safe to share
   * because `acceptRelationshipDelta` always replaces them via Map.set
   * rather than mutating the array in place.
   */
  clone(): ModelSnapshot {
    const cloned = Object.create(ModelSnapshot.prototype) as ModelSnapshot;
    Object.defineProperty(cloned, "scalars", {
      value: new Map(this.scalars),
      enumerable: true,
    });
    Object.defineProperty(cloned, "relationships", {
      value: new Map(this.relationships),
      enumerable: true,
    });
    Object.defineProperty(cloned, "wasNew", {
      value: this.wasNew,
      enumerable: true,
    });
    return cloned;
  }

  /**
   * Empty `originalSnapshot` for not-yet-persisted entities — represents
   * "nothing in DB yet." Diffing against this means the current snapshot
   * is fully emitted as additions. `acceptRelationshipDelta` can promote
   * individual wirer-driven deltas into the original snapshot to suppress
   * wired-side re-emission.
   */
  static emptyOriginal(): ModelSnapshot {
    return Object.create(ModelSnapshot.prototype, {
      scalars: { value: new Map(), enumerable: true },
      relationships: { value: new Map(), enumerable: true },
      wasNew: { value: true, enumerable: true },
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
