import { Model } from "../Model";
import { getEntityAttrs, getEntityLinks, readField } from "../store/EntityMeta";
import { collectModelValueObjectFields } from "../decorators/valueObject";
import type { RawEntityData } from "../store/types";

export class ModelSnapshot {
  readonly scalars = new Map<string, unknown>();
  readonly relationships = new Map<string, string | string[] | null>();

  constructor(model: Model | null = null) {
    if (model === null) return;
    const entityName = model.entityName;
    const voFields = collectModelValueObjectFields(model.constructor);
    const filledByVO = new Set<string>();
    for (const voField of voFields) {
      voField.captureSnapshot(model, "", this.scalars);
      for (const col of voField.ownedColumns("")) filledByVO.add(col);
    }

    for (const fieldName of Object.keys(getEntityAttrs(entityName))) {
      if (filledByVO.has(fieldName)) continue;
      this.scalars.set(fieldName, readField(model, fieldName));
    }

    for (const [fieldName, linkAttr] of Object.entries(getEntityLinks(entityName))) {
      const value = readField(model, fieldName);

      if (linkAttr.cardinality === "one") {
        const id = value instanceof Model ? value.id : null;
        this.relationships.set(fieldName, id);
      } else {
        const ids: string[] = [];
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item instanceof Model) ids.push(item.id);
          }
        }
        this.relationships.set(fieldName, ids);
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
