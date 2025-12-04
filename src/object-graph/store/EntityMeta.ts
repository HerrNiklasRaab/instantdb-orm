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

export class RelationshipFieldMeta {
  readonly fieldName: string;
  readonly targetEntity: EntityName;
  readonly cardinality: "one" | "many";

  constructor(
    readonly linkName: string,
    link: LinkDef,
    readonly isForward: boolean
  ) {
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
  readonly schemaName: EntityName;
  readonly scalarFields: string[];
  readonly requiredFields: string[];
  readonly optionalFields: string[];
  readonly relationshipFields: RelationshipFieldMeta[];
  readonly dateFields: Set<string>;

  constructor(schema: SchemaConfig, entityName: EntityName) {
    this.schemaName = entityName;

    const entityDef = schema.entities[entityName];
    const attrs = entityDef?.attrs ?? {};

    this.scalarFields = Object.keys(attrs);
    this.requiredFields = this.extractRequiredFields(attrs);
    this.optionalFields = this.extractOptionalFields(attrs);
    this.dateFields = this.extractDateFields(attrs);
    this.relationshipFields = this.extractRelationshipFields(schema);
  }

  private extractRequiredFields(attrs: Record<string, AttrDef>): string[] {
    return Object.entries(attrs)
      .filter(([, attrDef]) => attrDef.required !== false)
      .map(([fieldName]) => fieldName);
  }

  private extractOptionalFields(attrs: Record<string, AttrDef>): string[] {
    return Object.entries(attrs)
      .filter(([, attrDef]) => attrDef.required === false)
      .map(([fieldName]) => fieldName);
  }

  private extractDateFields(attrs: Record<string, AttrDef>): Set<string> {
    const dateFields = new Set<string>();
    for (const [fieldName, attrDef] of Object.entries(attrs)) {
      if (attrDef.valueType === "date") {
        dateFields.add(fieldName);
      }
    }
    return dateFields;
  }

  private extractRelationshipFields(schema: SchemaConfig): RelationshipFieldMeta[] {
    const relationships: RelationshipFieldMeta[] = [];
    const allEntityNames = new Set(Object.keys(schema.entities));

    for (const [linkName, link] of Object.entries(schema.links)) {
      // Forward side
      if (link.forward.on === this.schemaName && allEntityNames.has(link.reverse.on)) {
        relationships.push(new RelationshipFieldMeta(linkName, link, true));
      }

      // Reverse side
      if (link.reverse.on === this.schemaName && allEntityNames.has(link.forward.on)) {
        relationships.push(new RelationshipFieldMeta(linkName, link, false));
      }
    }

    return relationships;
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
