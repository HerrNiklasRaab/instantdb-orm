// Generic entity name type - will be narrowed by configuration
export type EntityName = string;

export interface RelationshipFieldMeta {
  fieldName: string;
  targetEntity: EntityName;
  linkName: string;
  cardinality: "one" | "many";
  isForward: boolean;
}

export interface EntityMeta {
  schemaName: EntityName;
  scalarFields: string[];
  relationshipFields: RelationshipFieldMeta[];
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
let DATE_FIELDS: Set<string> = new Set();
let ENTITY_NAMES: EntityName[] = [];

function extractDateFields(schema: SchemaConfig): Set<string> {
  const dateFields = new Set<string>();

  for (const entityDef of Object.values(schema.entities)) {
    if (!entityDef?.attrs) continue;
    for (const [fieldName, attrDef] of Object.entries(entityDef.attrs)) {
      if (attrDef.valueType === "date") {
        dateFields.add(fieldName);
      }
    }
  }
  return dateFields;
}

function getScalarFields(schema: SchemaConfig, entityName: EntityName): string[] {
  const entityDef = schema.entities[entityName];
  return entityDef?.attrs ? Object.keys(entityDef.attrs) : [];
}

function buildEntityMeta(schema: SchemaConfig): Map<EntityName, EntityMeta> {
  const meta = new Map<EntityName, EntityMeta>();
  const entityNames = Object.keys(schema.entities);

  // Initialize with scalar fields
  for (const entityName of entityNames) {
    meta.set(entityName, {
      schemaName: entityName,
      scalarFields: getScalarFields(schema, entityName),
      relationshipFields: [],
    });
  }

  // Add relationship fields from links
  for (const [linkName, link] of Object.entries(schema.links)) {
    const forwardEntity = link.forward.on;
    const reverseEntity = link.reverse.on;

    // Forward side
    if (meta.has(forwardEntity) && meta.has(reverseEntity)) {
      const forwardMeta = meta.get(forwardEntity)!;
      forwardMeta.relationshipFields.push({
        fieldName: link.forward.label,
        targetEntity: reverseEntity,
        linkName,
        cardinality: link.forward.has as "one" | "many",
        isForward: true,
      });
    }

    // Reverse side
    if (meta.has(reverseEntity) && meta.has(forwardEntity)) {
      const reverseMeta = meta.get(reverseEntity)!;
      reverseMeta.relationshipFields.push({
        fieldName: link.reverse.label,
        targetEntity: forwardEntity,
        linkName,
        cardinality: link.reverse.has as "one" | "many",
        isForward: false,
      });
    }
  }

  return meta;
}

/**
 * Configure the entity metadata system with a schema.
 * Must be called before using getEntityMeta or other metadata functions.
 */
export function configureEntityMeta(schema: SchemaConfig): void {
  ENTITY_META = buildEntityMeta(schema);
  DATE_FIELDS = extractDateFields(schema);
  ENTITY_NAMES = Object.keys(schema.entities);
}

export function getEntityMeta(entityName: EntityName): EntityMeta {
  const meta = ENTITY_META.get(entityName);
  if (!meta) {
    throw new Error(`No metadata for entity: ${entityName}. Did you call configureEntityMeta()?`);
  }
  return meta;
}

export function getDateFields(): Set<string> {
  return DATE_FIELDS;
}

export function getEntityNames(): EntityName[] {
  return ENTITY_NAMES;
}

export function isValidEntityName(name: string): name is EntityName {
  return ENTITY_NAMES.includes(name);
}

// For backwards compatibility - re-export (now mutable internally)
export { ENTITY_META, DATE_FIELDS };
