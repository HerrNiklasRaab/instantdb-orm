import type { Model } from "../Model";
import type { EntityConstructor } from "./types";

// Re-export metadata from EntityMeta
export {
  type EntityName,
  type EntityMeta,
  type RelationshipFieldMeta,
  getEntityMeta,
  getEntityNames,
  isValidEntityName,
  configureEntityMeta,
  type SchemaConfig,
} from "./EntityMeta";

// Mutable registry - populated by @model decorator
const ENTITY_REGISTRY: Map<string, EntityConstructor<Model>> = new Map();

export function getEntityClass(entityName: string): EntityConstructor<Model> {
  const EntityClass = ENTITY_REGISTRY.get(entityName);
  if (!EntityClass) {
    throw new Error(
      `Unknown entity type: ${entityName}. Did you add @model decorator to the entity class?`
    );
  }
  return EntityClass;
}

export function getRegisteredEntityNames(): string[] {
  return Array.from(ENTITY_REGISTRY.keys());
}

export function isRegisteredEntity(name: string): boolean {
  return ENTITY_REGISTRY.has(name);
}

// Exported for @model decorator
export { ENTITY_REGISTRY };

// Generic type helpers
export type EntityInstanceFor<_K extends string> = Model;
export type EntityClassFor<_K extends string> = EntityConstructor<Model>;
