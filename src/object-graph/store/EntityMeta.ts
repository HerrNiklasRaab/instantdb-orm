import type {
  AttrsDefs,
  CardinalityKind,
  EntitiesDef,
  EntityDef,
  InstantSchemaDef,
  LinkAttrDef,
  LinksDef,
  RoomsDef,
} from "@instantdb/core";
import { getBackingFieldName } from "../decorators/field";

export type EntityName = string;

type SchemaConfig = InstantSchemaDef<
  Record<string, EntityDef<AttrsDefs, Record<string, LinkAttrDef<CardinalityKind, string>>, void>>,
  LinksDef<EntitiesDef>,
  RoomsDef
>;

type EntityLinksMap = Record<string, LinkAttrDef<CardinalityKind, string>>;

export function getFieldNameOnModel(entity: object, fieldName: string): string {
  const backingField = getBackingFieldName(entity.constructor, fieldName);
  return backingField ?? fieldName;
}

export function readField(entity: object, fieldName: string): unknown {
  return Reflect.get(entity, getFieldNameOnModel(entity, fieldName));
}

export function writeField(entity: object, fieldName: string, value: unknown): void {
  Reflect.set(entity, getFieldNameOnModel(entity, fieldName), value);
}

let SCHEMA: SchemaConfig | null = null;
let ENTITY_NAMES: EntityName[] = [];

function requireSchema(): SchemaConfig {
  if (!SCHEMA) {
    throw new Error(
      "EntityMeta: schema not configured. Did you call configureEntityMeta()?"
    );
  }
  return SCHEMA;
}

function requireEntity(entityName: EntityName) {
  const schema = requireSchema();
  if (!(entityName in schema.entities)) {
    throw new Error(
      `No metadata for entity: ${entityName}. Did you call configureEntityMeta()?`
    );
  }
  return schema.entities[entityName];
}

export function getEntityAttrs(entityName: EntityName): AttrsDefs {
  return requireEntity(entityName).attrs;
}

export function getEntityLinks(entityName: EntityName): EntityLinksMap {
  return requireEntity(entityName).links;
}

export function findReverseSide(
  entityName: EntityName,
  fieldName: string
): readonly [entity: string, fieldName: string, cardinality: CardinalityKind] | undefined {
  for (const link of Object.values(requireSchema().links)) {
    if (link.forward.on === entityName && link.forward.label === fieldName) {
      return [link.reverse.on, link.reverse.label, link.reverse.has] as const;
    }
    if (link.reverse.on === entityName && link.reverse.label === fieldName) {
      return [link.forward.on, link.forward.label, link.forward.has] as const;
    }
  }
  return undefined;
}

const TIMESTAMP_FIELDS = ["createdAt", "updatedAt", "deletedAt"] as const;

function validateTimestampFields(
  entityName: string,
  attrs: AttrsDefs
): void {
  const isSystemEntity = entityName.startsWith("$");
  const fields = Object.keys(attrs);

  for (const field of TIMESTAMP_FIELDS) {
    if (!fields.includes(field)) {
      throw new Error(
        `Entity "${entityName}" is missing required field "${field}". ` +
        `All entities must have createdAt, updatedAt, and deletedAt fields.`
      );
    }
  }

  for (const field of ["createdAt", "updatedAt"] as const) {
    const isOptional = attrs[field].required === false;
    if (isSystemEntity) {
      if (!isOptional) {
        throw new Error(
          `Entity "${entityName}": "${field}" must be optional for system entities (starting with $).`
        );
      }
    } else {
      if (isOptional) {
        throw new Error(
          `Entity "${entityName}": "${field}" must be required (not optional).`
        );
      }
    }
  }

  const deletedAtIsOptional = attrs["deletedAt"].required === false;
  if (!deletedAtIsOptional) {
    throw new Error(`Entity "${entityName}": "deletedAt" must be optional.`);
  }
}

export function configureEntityMeta(schema: SchemaConfig): void {
  for (const entityName of Object.keys(schema.entities)) {
    validateTimestampFields(entityName, schema.entities[entityName].attrs);
  }

  SCHEMA = schema;
  ENTITY_NAMES = Object.keys(schema.entities);
}

export function getEntityNames(): EntityName[] {
  return ENTITY_NAMES;
}

export function isValidEntityName(name: string): name is EntityName {
  return ENTITY_NAMES.includes(name);
}
