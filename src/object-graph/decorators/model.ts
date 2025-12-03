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
 *
 * @example
 * @model                    // User → "users"
 * class User extends Model { }
 *
 * @model("people")          // Override for irregular plurals
 * class Person extends Model { }
 */
// Overload: @model (no parentheses)
export function model<T extends ModelConstructor>(target: T): T;
// Overload: @model("people") (with custom name)
export function model(entityName: string): <T extends ModelConstructor>(target: T) => T;
// Implementation
export function model<T extends ModelConstructor>(
  targetOrName: T | string
): T | (<U extends ModelConstructor>(target: U) => U) {
  // Called with string: @model("people")
  if (typeof targetOrName === "string") {
    return <U extends ModelConstructor>(target: U): U => {
      (target as any)[ENTITY_NAME_KEY] = targetOrName;
      ENTITY_REGISTRY.set(targetOrName, target);
      return target;
    };
  }

  // Called directly: @model
  const entityName = deriveEntityName(targetOrName.name);
  (targetOrName as any)[ENTITY_NAME_KEY] = entityName;
  ENTITY_REGISTRY.set(entityName, targetOrName);
  return targetOrName;
}
