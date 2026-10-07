import type { FieldDef, ModelDef, SchemaDef } from "@zenstackhq/schema";
import type { ModelLinks } from "../../schema/ModelLinks";
import { SyncSchema } from "../../schema/SyncSchema";
import { getBackingFieldName } from "../decorators/field";
import { syncGlobalState } from "../globalState";

export type EntityName = string;

export type Cardinality = "one" | "many";

type EntityFieldMap = Readonly<Record<string, FieldDef>>;

export type ReverseSide = readonly [
  entity: string,
  fieldName: string,
  cardinality: Cardinality
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

function cardinalityOf(field: FieldDef): Cardinality {
  return field.array === true ? "many" : "one";
}

class EntityDescriptor {
  readonly attrs: EntityFieldMap;
  readonly links: EntityFieldMap;

  constructor(
    readonly name: EntityName,
    private readonly model: ModelDef
  ) {
    const foreignKeys = new Set<string>();
    for (const field of Object.values(model.fields)) {
      for (const column of field.relation?.fields ?? []) foreignKeys.add(column);
    }
    const attrs: Record<string, FieldDef> = {};
    const links: Record<string, FieldDef> = {};
    for (const [fieldName, field] of Object.entries(model.fields)) {
      if (field.relation) links[fieldName] = field;
      else if (!field.id && !foreignKeys.has(fieldName) && !field.computed) attrs[fieldName] = field;
    }
    this.attrs = attrs;
    this.links = links;
  }

  findReverseLink(fieldName: string, models: SchemaDef["models"]): ReverseSide | undefined {
    const field = this.model.fields[fieldName];
    const opposite = field?.relation?.opposite;
    if (!field || !opposite) return undefined;
    const oppositeField = models[field.type]?.fields[opposite];
    if (!oppositeField) return undefined;
    return [field.type, opposite, cardinalityOf(oppositeField)] as const;
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
      const isOptional = attr.optional === true;
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
    if (deletedAt && deletedAt.optional !== true) {
      throw new Error(`Entity "${this.name}": "deletedAt" must be optional.`);
    }
  }
}

export class EntityRegistry {
  private readonly descriptors: Map<EntityName, EntityDescriptor>;
  readonly names: readonly EntityName[];
  readonly sync: SyncSchema;

  constructor(private readonly schema: SchemaDef) {
    this.descriptors = new Map();
    this.sync = SyncSchema.of(schema);
    for (const [entityName, model] of Object.entries(this.sync.models)) {
      const descriptor = new EntityDescriptor(entityName, model);
      descriptor.validateTimestamps();
      this.descriptors.set(entityName, descriptor);
    }
    this.names = Array.from(this.descriptors.keys());
  }

  describes(schema: SchemaDef): boolean {
    return this.schema === schema;
  }

  findReverseSide(entityName: EntityName, fieldName: string): ReverseSide | undefined {
    return this.require(entityName).findReverseLink(fieldName, this.schema.models);
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

function requireRegistry(): EntityRegistry {
  const registry = syncGlobalState().entityRegistry;
  if (!registry) {
    throw new Error(
      "EntityMeta: schema not configured. Did you call configureEntityMeta()?"
    );
  }
  return registry;
}

export function configureEntityMeta(schema: SchemaDef): void {
  const state = syncGlobalState();
  if (state.entityRegistry?.describes(schema)) return;
  state.entityRegistry = new EntityRegistry(schema);
}

/** How an entity's links are stored, as the configured schema says. */
export function getEntityLinkStorage(entityName: EntityName): ModelLinks {
  return requireRegistry().sync.links(entityName);
}

export function getEntityAttrs(entityName: EntityName): EntityFieldMap {
  return requireRegistry().require(entityName).attrs;
}

export function getEntityLinks(entityName: EntityName): EntityFieldMap {
  return requireRegistry().require(entityName).links;
}

export function findReverseSide(
  entityName: EntityName,
  fieldName: string
): ReverseSide | undefined {
  return requireRegistry().findReverseSide(entityName, fieldName);
}

export function getEntityNames(): readonly EntityName[] {
  return syncGlobalState().entityRegistry?.names ?? [];
}

export function isValidEntityName(name: string): name is EntityName {
  return syncGlobalState().entityRegistry?.has(name) ?? false;
}
