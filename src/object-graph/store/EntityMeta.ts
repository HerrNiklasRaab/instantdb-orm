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

type SchemaLink = SchemaConfig["links"][string];

export type ReverseSide = readonly [
  entity: string,
  fieldName: string,
  cardinality: CardinalityKind
];

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

const TIMESTAMP_FIELDS = ["createdAt", "updatedAt", "deletedAt"] as const;
const CREATED_UPDATED = ["createdAt", "updatedAt"] as const;

class EntityDescriptor {
  constructor(
    readonly name: EntityName,
    readonly attrs: AttrsDefs,
    readonly links: EntityLinksMap,
    private readonly schemaLinks: readonly SchemaLink[]
  ) {}

  findReverseLink(fieldName: string): ReverseSide | undefined {
    for (const link of this.schemaLinks) {
      if (link.forward.on === this.name && link.forward.label === fieldName) {
        return [link.reverse.on, link.reverse.label, link.reverse.has] as const;
      }
      if (link.reverse.on === this.name && link.reverse.label === fieldName) {
        return [link.forward.on, link.forward.label, link.forward.has] as const;
      }
    }
    return undefined;
  }

  validateTimestamps(): void {
    const isSystemEntity = this.name.startsWith("$");
    const fields = Object.keys(this.attrs);

    for (const field of TIMESTAMP_FIELDS) {
      if (!fields.includes(field)) {
        throw new Error(
          `Entity "${this.name}" is missing required field "${field}". ` +
            `All entities must have createdAt, updatedAt, and deletedAt fields.`
        );
      }
    }

    for (const field of CREATED_UPDATED) {
      const attr = this.attrs[field];
      if (!attr) continue;
      const isOptional = attr.required === false;
      if (isSystemEntity && !isOptional) {
        throw new Error(
          `Entity "${this.name}": "${field}" must be optional for system entities (starting with $).`
        );
      }
      if (!isSystemEntity && isOptional) {
        throw new Error(
          `Entity "${this.name}": "${field}" must be required (not optional).`
        );
      }
    }

    const deletedAt = this.attrs["deletedAt"];
    if (deletedAt && deletedAt.required !== false) {
      throw new Error(`Entity "${this.name}": "deletedAt" must be optional.`);
    }
  }
}

class EntityRegistry {
  private readonly descriptors: Map<EntityName, EntityDescriptor>;
  readonly names: readonly EntityName[];

  constructor(schema: SchemaConfig) {
    const schemaLinks = Object.values(schema.links);
    this.descriptors = new Map();
    for (const [entityName, entity] of Object.entries(schema.entities)) {
      const descriptor = new EntityDescriptor(
        entityName,
        entity.attrs,
        entity.links,
        schemaLinks
      );
      descriptor.validateTimestamps();
      this.descriptors.set(entityName, descriptor);
    }
    this.names = Array.from(this.descriptors.keys());
  }

  require(entityName: EntityName): EntityDescriptor {
    const descriptor = this.descriptors.get(entityName);
    if (!descriptor) {
      throw new Error(
        `No metadata for entity: ${entityName}. Did you call configureEntityMeta()?`
      );
    }
    return descriptor;
  }

  has(entityName: string): boolean {
    return this.descriptors.has(entityName);
  }
}

let REGISTRY: EntityRegistry | null = null;

function requireRegistry(): EntityRegistry {
  if (!REGISTRY) {
    throw new Error(
      "EntityMeta: schema not configured. Did you call configureEntityMeta()?"
    );
  }
  return REGISTRY;
}

export function configureEntityMeta(schema: SchemaConfig): void {
  REGISTRY = new EntityRegistry(schema);
}

export function getEntityAttrs(entityName: EntityName): AttrsDefs {
  return requireRegistry().require(entityName).attrs;
}

export function getEntityLinks(entityName: EntityName): EntityLinksMap {
  return requireRegistry().require(entityName).links;
}

export function findReverseSide(
  entityName: EntityName,
  fieldName: string
): ReverseSide | undefined {
  return requireRegistry().require(entityName).findReverseLink(fieldName);
}

export function getEntityNames(): readonly EntityName[] {
  return REGISTRY?.names ?? [];
}

export function isValidEntityName(name: string): name is EntityName {
  return REGISTRY?.has(name) ?? false;
}
