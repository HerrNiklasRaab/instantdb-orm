import { Model, isModel } from "../Model";
import { getEntityAttrs, getEntityLinks, readField } from "../store/EntityMeta";
import { fieldsForModel } from "../store/fieldsForEntity";
import type { RawEntityData } from "../store/types";

export class ModelSnapshot {
  readonly scalars = new Map<string, unknown>();
  readonly relationships = new Map<string, string | string[] | null>();

  constructor(model: Model | null = null) {
    if (model === null) return;
    const entityName = model.entityName;
    for (const field of fieldsForModel(model.constructor, entityName)) {
      field.captureSnapshot(model, "", this.scalars);
    }

    // The STI discriminator is a read-only getter, not a writable Field, so it
    // is excluded from the field set — but it must still be written to its
    // column. Capture it directly when the entity has a `modelType` attr.
    if ("modelType" in getEntityAttrs(entityName)) {
      this.scalars.set("modelType", readField(model, "modelType"));
    }

    for (const [fieldName, linkAttr] of Object.entries(getEntityLinks(entityName))) {
      const value = readField(model, fieldName);

      if (linkAttr.cardinality === "one") {
        const id = isModel(value) ? value.id : null;
        this.relationships.set(fieldName, id);
      } else {
        const ids: string[] = [];
        if (Array.isArray(value)) {
          for (const item of value) {
            if (isModel(item)) ids.push(item.id);
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
      data[fieldName] = value;
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
