import {
  MODEL_REGISTRY,
  registerDiscriminator,
} from "../store/EntityRegistry";
import { ENTITY_NAME_KEY, deriveEntityName } from "./model-utils";

// Re-export for backwards compatibility
export { ENTITY_NAME_KEY, deriveEntityName } from "./model-utils";

// Local type to avoid circular dependency with Model.ts
type ModelClassType = new (...args: any[]) => { id: string };

/** Get entity name from a class (set by @model decorator) */
export function getEntityNameFromClass(
  ModelClass: ModelClassType
): string {
  const stored = (ModelClass as any)[ENTITY_NAME_KEY];
  if (!stored) {
    throw new Error(
      `Model class ${ModelClass.name} has no entity name. Did you add @model decorator?`
    );
  }
  return stored;
}

/**
 * Finds the root domain class (first class in prototype chain whose parent is Model).
 * For STI, this determines the shared table name.
 * Uses name comparison to avoid circular import with Model.ts.
 */
function findRootModelClass(target: ModelClassType): ModelClassType {
  let current: Function = target;
  while (current && current.name !== "Model") {
    const parent = Object.getPrototypeOf(current);
    if (parent?.name === "Model") {
      return current as ModelClassType;
    }
    current = parent;
  }
  return target;
}

/**
 * Reads discriminator value from 'type' getter on the class prototype.
 * The type must be defined as a getter: `get type() { return "value"; }`
 */
function getDiscriminatorValue(target: ModelClassType): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target.prototype, "type");
  if (!descriptor) return undefined;

  // Handle getter: get type() { return "value"; }
  if (typeof descriptor.get === "function") {
    return descriptor.get.call(null);
  }

  // Handle value property (unlikely but fallback)
  return descriptor.value;
}

/**
 * Registers a model class in the registry.
 * Derives entity name from class name: User → "users"
 * For STI subclasses, derives entity name from root domain class.
 *
 * @example
 * @model
 * class User extends Model { }
 *
 * @example STI
 * abstract class MatchRequest extends Model { }
 *
 * @model
 * class ChessMatchRequest extends MatchRequest {
 *   get type() { return "chess"; }
 * }
 */
export function model<T extends ModelClassType>(target: T): T {
  const rootClass = findRootModelClass(target);
  const isSubclass = rootClass !== target;

  // Derive entity name from ROOT class (STI: all subclasses share same table)
  const entityName = deriveEntityName(rootClass.name);
  (target as any)[ENTITY_NAME_KEY] = entityName;

  if (isSubclass) {
    // STI subclass - only register discriminator mapping
    // Don't overwrite MODEL_REGISTRY (hydrator uses discriminator to resolve class)
    const discriminatorValue = getDiscriminatorValue(target);
    if (discriminatorValue) {
      registerDiscriminator(entityName, discriminatorValue, target as any);
    }
  } else {
    // Root class or non-STI class - register in main registry
    MODEL_REGISTRY.set(entityName, target as any);
  }

  return target;
}
