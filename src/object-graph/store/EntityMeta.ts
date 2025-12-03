// Generic entity name type - will be narrowed by configuration
export type EntityName = string;

export class RelationshipFieldMeta {
  constructor(
    readonly fieldName: string,
    readonly targetEntity: EntityName,
    readonly linkName: string,
    readonly cardinality: "one" | "many",
    readonly isForward: boolean
  ) {}

  isToOne(): boolean {
    return this.cardinality === "one";
  }

  isToMany(): boolean {
    return this.cardinality === "many";
  }
}

export class EntityMeta {
  readonly schemaName: EntityName;
  readonly scalarFields: string[];
  readonly relationshipFields: RelationshipFieldMeta[];
  readonly dateFields: Set<string>;

  constructor(
    schemaName: EntityName,
    scalarFields: string[],
    relationshipFields: RelationshipFieldMeta[],
    dateFields: Set<string>
  ) {
    this.schemaName = schemaName;
    this.scalarFields = scalarFields;
    this.relationshipFields = relationshipFields;
    this.dateFields = dateFields;
  }

  isDateField(name: string): boolean {
    return this.dateFields.has(name);
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

// Schema types for configuration
interface AttrDef {
  valueType: string;
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

// Mutable state - configured at runtime
let ENTITY_META: Map<EntityName, EntityMeta> = new Map();
let ENTITY_NAMES: EntityName[] = [];

function extractDateFieldsForEntity(schema: SchemaConfig, entityName: EntityName): Set<string> {
  const dateFields = new Set<string>();
  const entityDef = schema.entities[entityName];
  if (!entityDef?.attrs) return dateFields;

  for (const [fieldName, attrDef] of Object.entries(entityDef.attrs)) {
    if (attrDef.valueType === "date") {
      dateFields.add(fieldName);
    }
  }
  return dateFields;
}

function getScalarFields(schema: SchemaConfig, entityName: EntityName): string[] {
  const entityDef = schema.entities[entityName];
  return entityDef?.attrs ? Object.keys(entityDef.attrs) : [];
}

function buildRelationshipFields(
  schema: SchemaConfig,
  entityName: EntityName
): RelationshipFieldMeta[] {
  const relationships: RelationshipFieldMeta[] = [];
  const entityNames = new Set(Object.keys(schema.entities));

  for (const [linkName, link] of Object.entries(schema.links)) {
    // Forward side: this entity owns the forward relationship
    if (link.forward.on === entityName && entityNames.has(link.reverse.on)) {
      relationships.push(
        new RelationshipFieldMeta(
          link.forward.label,
          link.reverse.on,
          linkName,
          link.forward.has as "one" | "many",
          true
        )
      );
    }

    // Reverse side: this entity owns the reverse relationship
    if (link.reverse.on === entityName && entityNames.has(link.forward.on)) {
      relationships.push(
        new RelationshipFieldMeta(
          link.reverse.label,
          link.forward.on,
          linkName,
          link.reverse.has as "one" | "many",
          false
        )
      );
    }
  }

  return relationships;
}

function buildEntityMeta(schema: SchemaConfig): Map<EntityName, EntityMeta> {
  const meta = new Map<EntityName, EntityMeta>();

  for (const entityName of Object.keys(schema.entities)) {
    meta.set(
      entityName,
      new EntityMeta(
        entityName,
        getScalarFields(schema, entityName),
        buildRelationshipFields(schema, entityName),
        extractDateFieldsForEntity(schema, entityName)
      )
    );
  }

  return meta;
}

/**
 * Configure the entity metadata system with a schema.
 * Must be called before using getEntityMeta or other metadata functions.
 */
export function configureEntityMeta(schema: SchemaConfig): void {
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
