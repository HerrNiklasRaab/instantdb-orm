import { ENTITY_REGISTRY } from "../store/EntityRegistry";
import type { Model as ModelClass } from "../Model";

type ModelConstructor = new (id: string) => ModelClass;

/** Symbol to store entity name on the class */
export const ENTITY_NAME_KEY = Symbol("entityName");

/** Derive entity name from class name: User → "users" */
export function deriveEntityName(className: string): string {
  if (className.startsWith("$")) {
    return "$" + className.slice(1).toLowerCase() + "s";
  }
  return className.toLowerCase() + "s";
}

/** Get entity name from a class (set by @model decorator) */
export function getEntityNameFromClass(
  EntityClass: ModelConstructor
): string {
  const stored = (EntityClass as any)[ENTITY_NAME_KEY];
  if (!stored) {
    throw new Error(
      `Entity class ${EntityClass.name} has no entity name. Did you add @model decorator?`
    );
  }
  return stored;
}

/**
 * Registers an entity class in the registry.
 * Derives entity name from class name: User → "users"
 *
 * @example
 * @model
 * class User extends Model { }
 */
export function model<T extends ModelConstructor>(target: T): T {
  const entityName = deriveEntityName(target.name);
  (target as any)[ENTITY_NAME_KEY] = entityName;
  ENTITY_REGISTRY.set(entityName, target);
  return target;
}
