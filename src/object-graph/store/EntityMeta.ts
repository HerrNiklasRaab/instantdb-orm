import { getBackingFieldName } from "../decorators/field";

// Generic entity name type - will be narrowed by configuration
export type EntityName = string;

// Schema types for configuration
interface AttrDef {
  valueType: string;
  required?: boolean;
}

interface EntityDef {
  attrs: Record<string, AttrDef>;
  links: Record<string, unknown>;
}

interface LinkDef {
  forward: { on: string; has: string; label: string };
  reverse: { on: string; has: string; label: string };
}

export interface SchemaConfig {
  entities: Record<string, EntityDef>;
  links: Record<string, LinkDef>;
}

export abstract class FieldMeta {
  abstract readonly fieldName: string;

  getFieldNameOnModel(entity: object): string {
    const ModelClass = entity.constructor as abstract new (...args: never[]) => object;
    const backingField = getBackingFieldName(ModelClass, this.fieldName);
    return backingField ?? this.fieldName;
  }
}

export class ScalarFieldMeta extends FieldMeta {
  constructor(
    readonly fieldName: string,
    readonly valueType: string,
    readonly isDate: boolean
  ) {
    super();
  }
}

export class RelationshipFieldMeta extends FieldMeta {
  readonly fieldName: string;
  readonly targetEntity: EntityName;
  readonly cardinality: "one" | "many";

  constructor(
    readonly linkName: string,
    link: LinkDef,
    readonly isForward: boolean
  ) {
    super();
    const side = isForward ? link.forward : link.reverse;
    const otherSide = isForward ? link.reverse : link.forward;

    this.fieldName = side.label;
    this.targetEntity = otherSide.on;
    this.cardinality = side.has as "one" | "many";
  }

  isToOne(): boolean {
    return this.cardinality === "one";
  }

  isToMany(): boolean {
    return this.cardinality === "many";
  }
}

export class EntityMeta {
  readonly scalarFields: ScalarFieldMeta[] = [];
  readonly relationshipFields: RelationshipFieldMeta[] = [];

  constructor(
    private schema: SchemaConfig,
    readonly schemaName: EntityName
  ) {
    this.extractScalarFields();
    this.extractRelationshipFields();
  }

  /** All fields (scalar + relationship) unified under FieldMeta interface */
  get fields(): FieldMeta[] {
    return [...this.scalarFields, ...this.relationshipFields];
  }

  private get attrs(): Record<string, AttrDef> {
    return this.schema.entities[this.schemaName]?.attrs ?? {};
  }

  private extractScalarFields(): void {
    for (const [fieldName, attrDef] of Object.entries(this.attrs)) {
      this.scalarFields.push(
        new ScalarFieldMeta(fieldName, attrDef.valueType, attrDef.valueType === "date")
      );
    }
  }

  private extractRelationshipFields(): void {
    const allEntityNames = new Set(Object.keys(this.schema.entities));

    for (const [linkName, link] of Object.entries(this.schema.links)) {
      // Forward side
      if (link.forward.on === this.schemaName && allEntityNames.has(link.reverse.on)) {
        this.relationshipFields.push(new RelationshipFieldMeta(linkName, link, true));
      }

      // Reverse side
      if (link.reverse.on === this.schemaName && allEntityNames.has(link.forward.on)) {
        this.relationshipFields.push(new RelationshipFieldMeta(linkName, link, false));
      }
    }
  }

  getRelationshipFieldNames(): Set<string> {
    return new Set(this.relationshipFields.map((r) => r.fieldName));
  }

  findReverseRelationship(
    linkName: string,
    excludeFieldName?: string
  ): RelationshipFieldMeta | undefined {
    return this.relationshipFields.find(
      (r) => r.linkName === linkName && r.fieldName !== excludeFieldName
    );
  }
}

// Mutable state - configured at runtime
let ENTITY_META: Map<EntityName, EntityMeta> = new Map();
let ENTITY_NAMES: EntityName[] = [];

function buildEntityMeta(schema: SchemaConfig): Map<EntityName, EntityMeta> {
  const meta = new Map<EntityName, EntityMeta>();

  for (const entityName of Object.keys(schema.entities)) {
    meta.set(entityName, new EntityMeta(schema, entityName));
  }

  return meta;
}

const TIMESTAMP_FIELDS = ["createdAt", "updatedAt", "deletedAt"] as const;

/**
 * Validates timestamp fields for an entity.
 * - createdAt and updatedAt must exist and be required
 * - deletedAt must exist and be optional
 * - Exception: entities starting with $ have all timestamps optional
 */
function validateTimestampFields(
  entityName: string,
  attrs: Record<string, AttrDef>
): void {
  const isSystemEntity = entityName.startsWith("$");
  const fields = Object.keys(attrs);

  // Check field existence
  for (const field of TIMESTAMP_FIELDS) {
    if (!fields.includes(field)) {
      throw new Error(
        `Entity "${entityName}" is missing required field "${field}". ` +
        `All entities must have createdAt, updatedAt, and deletedAt fields.`
      );
    }
  }

  // Check optionality for createdAt and updatedAt
  for (const field of ["createdAt", "updatedAt"] as const) {
    const isOptional = attrs[field].required === false;
    if (isSystemEntity) {
      // System entities: timestamps should be optional
      if (!isOptional) {
        throw new Error(
          `Entity "${entityName}": "${field}" must be optional for system entities (starting with $).`
        );
      }
    } else {
      // Regular entities: timestamps must be required
      if (isOptional) {
        throw new Error(
          `Entity "${entityName}": "${field}" must be required (not optional).`
        );
      }
    }
  }

  // Check optionality for deletedAt - must always be optional
  const deletedAtIsOptional = attrs["deletedAt"].required === false;
  if (!deletedAtIsOptional) {
    throw new Error(`Entity "${entityName}": "deletedAt" must be optional.`);
  }
}

/**
 * Configure the entity metadata system with a schema.
 * Must be called before using getEntityMeta or other metadata functions.
 * Validates that all entities have required timestamp fields with correct optionality.
 */
export function configureEntityMeta(schema: SchemaConfig): void {
  // Validate schema timestamp fields
  for (const entityName of Object.keys(schema.entities)) {
    const attrs = schema.entities[entityName]?.attrs ?? {};
    validateTimestampFields(entityName, attrs);
  }

  ENTITY_META = buildEntityMeta(schema);
  ENTITY_NAMES = Object.keys(schema.entities);
}

export function getEntityMeta(entityName: EntityName): EntityMeta {
  const meta = ENTITY_META.get(entityName);
  if (!meta) {
    throw new Error(`No metadata for entity: ${entityName}. Did you call configureEntityMeta()?`);
  }
  return meta;
}

export function getEntityNames(): EntityName[] {
  return ENTITY_NAMES;
}

export function isValidEntityName(name: string): name is EntityName {
  return ENTITY_NAMES.includes(name);
}

// For backwards compatibility - re-export (now mutable internally)
export { ENTITY_META };

/**
 * Resolves the actual property name on an entity for a given schema field.
 * Uses @field decorator registry to find private backing fields.
 */
export function getPropertyName(entity: object, schemaField: string): string {
  const ModelClass = entity.constructor as abstract new (...args: never[]) => object;
  const backingField = getBackingFieldName(ModelClass, schemaField);
  return backingField ?? schemaField;
}
