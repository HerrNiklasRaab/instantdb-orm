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

// STI discriminator registry: entityName -> Map<discriminatorValue, ConcreteClass>
const DISCRIMINATOR_REGISTRY: Map<
  string,
  Map<string, EntityConstructor<Model>>
> = new Map();

export function registerDiscriminator(
  entityName: string,
  discriminatorValue: string,
  EntityClass: EntityConstructor<Model>
): void {
  let discriminatorMap = DISCRIMINATOR_REGISTRY.get(entityName);
  if (!discriminatorMap) {
    discriminatorMap = new Map();
    DISCRIMINATOR_REGISTRY.set(entityName, discriminatorMap);
  }
  discriminatorMap.set(discriminatorValue, EntityClass);
}

export function getEntityClassForDiscriminator(
  entityName: string,
  discriminatorValue: string
): EntityConstructor<Model> | undefined {
  return DISCRIMINATOR_REGISTRY.get(entityName)?.get(discriminatorValue);
}

export function hasDiscriminatorMapping(entityName: string): boolean {
  const map = DISCRIMINATOR_REGISTRY.get(entityName);
  return map !== undefined && map.size > 0;
}

export function getEntityClass(entityName: string): EntityConstructor<Model> {
  const EntityClass = ENTITY_REGISTRY.get(entityName);
  if (EntityClass) {
    return EntityClass;
  }

  // For STI entities, return the first registered subclass as default
  // (actual instantiation will use resolveEntityClass which checks discriminator)
  const discriminatorMap = DISCRIMINATOR_REGISTRY.get(entityName);
  if (discriminatorMap && discriminatorMap.size > 0) {
    const firstClass = discriminatorMap.values().next().value;
    if (firstClass) return firstClass;
  }

  throw new Error(
    `Unknown entity type: ${entityName}. Did you add @model decorator to the entity class?`
  );
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
