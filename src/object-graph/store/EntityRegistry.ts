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

// Mutable registry - configured at runtime
const ENTITY_REGISTRY: Map<string, EntityConstructor<Model>> = new Map();

/**
 * Register an entity class for a given entity name.
 */
export function registerEntity<T extends Model>(
  entityName: string,
  EntityClass: EntityConstructor<T>
): void {
  ENTITY_REGISTRY.set(entityName, EntityClass as EntityConstructor<Model>);
}

/**
 * Register multiple entities at once.
 */
export function registerEntities(
  entities: Record<string, EntityConstructor<Model>>
): void {
  for (const [name, EntityClass] of Object.entries(entities)) {
    ENTITY_REGISTRY.set(name, EntityClass);
  }
}

/**
 * Creates a type-safe entity registry and registers entities at runtime.
 * Returns the registry object for use as a type parameter with RootStore.
 *
 * @example
 * const registry = createEntityRegistry({
 *   users: User,
 *   accounts: Account,
 * });
 *
 * const store = new RootStore<typeof registry>({ db });
 * const user = store.getById("users", "123"); // type: User | undefined
 */
export function createEntityRegistry<
  T extends Record<string, EntityConstructor>
>(entities: T): T {
  for (const [name, EntityClass] of Object.entries(entities)) {
    ENTITY_REGISTRY.set(name, EntityClass as EntityConstructor<Model>);
  }
  return entities;
}

export function getEntityClass(entityName: string): EntityConstructor<Model> {
  const EntityClass = ENTITY_REGISTRY.get(entityName);
  if (!EntityClass) {
    throw new Error(
      `Unknown entity type: ${entityName}. Did you call registerEntity()?`
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

// For backwards compatibility
export { ENTITY_REGISTRY };

// Generic type helpers
export type EntityInstanceFor<_K extends string> = Model;
export type EntityClassFor<_K extends string> = EntityConstructor<Model>;
