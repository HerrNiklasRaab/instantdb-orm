import type { Model } from "../Model";
import { getEntityMeta } from "../store/EntityMeta";

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

    this.wasNew = wasNew ?? model._tracker?.isNew() ?? true;
  }
}
