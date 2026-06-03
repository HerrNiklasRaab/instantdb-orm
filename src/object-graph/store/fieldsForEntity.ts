import { collectAllFields, type AttrValueType, type Field } from "../decorators/valueObject";
import { getEntityAttrs, type EntityName } from "./EntityMeta";

/**
 * The single field set for a model's entity: one `Field` (with a codec) per
 * schema column. Bridges the schema's attr `valueType`s into `collectAllFields`
 * so the persistence layer never special-cases un-annotated columns — every
 * column read/write goes through a codec.
 */
export function fieldsForModel(ModelClass: object, entityName: EntityName): Field[] {
  const attrs = getEntityAttrs(entityName);
  const valueTypes: AttrValueType[] = [];
  for (const [column, attr] of Object.entries(attrs)) {
    valueTypes.push({ column, valueType: attr.valueType });
  }
  return collectAllFields(ModelClass, valueTypes);
}
