import { modelRegistry } from "../store/ModelRegistry";
import type { ModelConstructor } from "../store/types";
import { ENTITY_NAME_KEY, deriveEntityName } from "./model-utils";

export { ENTITY_NAME_KEY, deriveEntityName } from "./model-utils";

type ModelClassType = (abstract new (...args: never[]) => { id: string })
  | { prototype: { id: string }; name: string };

type EntityNameHolder = { [ENTITY_NAME_KEY]?: string };

/** Get entity name from a class (set by @model decorator) */
export function getEntityNameFromClass(
  ModelClass: ModelClassType
): string {
  const stored = (ModelClass as EntityNameHolder)[ENTITY_NAME_KEY];
  if (!stored) {
    throw new Error(
      `Model class ${(ModelClass as { name?: string }).name} has no entity name. Did you add @model decorator?`
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
  let current: ModelClassType | null = target;
  while (current && (current as { name?: string }).name !== "Model") {
    const parent = Object.getPrototypeOf(current) as ModelClassType | null;
    if (parent && (parent as { name?: string }).name === "Model") {
      return current;
    }
    current = parent;
  }
  return target;
}

/**
 * Reads discriminator value from 'modelType' getter on the class prototype.
 * The modelType must be defined as a getter: `get modelType() { return "value"; }`
 */
function getDiscriminatorValue(target: ModelClassType): string | undefined {
  const proto = (target as unknown as { prototype: object }).prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "modelType");
  if (!descriptor) return undefined;

  if (typeof descriptor.get === "function") {
    return descriptor.get.call(null) as string | undefined;
  }

  return descriptor.value as string | undefined;
}

/**
 * Internal helper that applies the @model decorator logic.
 */
function applyModelDecorator<T extends ModelClassType>(
  target: T,
  explicitEntityName?: string
): T {
  const rootClass = findRootModelClass(target);
  const isSubclass = rootClass !== target;

  const entityName = explicitEntityName ?? deriveEntityName((rootClass as { name: string }).name);
  (target as EntityNameHolder)[ENTITY_NAME_KEY] = entityName;

  const asModelCtor = target as unknown as ModelConstructor;

  if (isSubclass) {
    const discriminatorValue = getDiscriminatorValue(target);
    if (discriminatorValue) {
      modelRegistry.registerDiscriminator(entityName, discriminatorValue, asModelCtor);
    } else {
      const ownEntityName = explicitEntityName ?? deriveEntityName((target as { name: string }).name);
      (target as EntityNameHolder)[ENTITY_NAME_KEY] = ownEntityName;
      modelRegistry.register(ownEntityName, asModelCtor);
    }
  } else {
    modelRegistry.register(entityName, asModelCtor);
  }

  let parent = Object.getPrototypeOf(target) as ModelClassType | null;
  while (parent && (parent as { name?: string }).name !== "Model") {
    modelRegistry.registerSubclass(parent as abstract new (...args: never[]) => object, asModelCtor);
    parent = Object.getPrototypeOf(parent) as ModelClassType | null;
  }

  return target;
}

/**
 * Registers a model class in the registry.
 * Derives entity name from class name: User → "users"
 * Or accepts explicit entity name: @model("users")
 * For STI subclasses, derives entity name from root domain class.
 *
 * @example
 * @model
 * class User extends Model { }
 *
 * @example with explicit name
 * @model("users")
 * class AppUser extends Model { }
 *
 * @example STI
 * abstract class MatchInvitation extends Model { }
 *
 * @model
 * class ChessMatchInvitation extends MatchInvitation {
 *   get modelType() { return "chess"; }
 * }
 */
export function model<T extends ModelClassType>(target: T): T;
export function model(entityName: string): <T extends ModelClassType>(target: T) => T;
export function model(
  targetOrEntityName: ModelClassType | string
): ModelClassType | (<T extends ModelClassType>(target: T) => T) {
  if (typeof targetOrEntityName === "string") {
    // Called as @model("entityName") - return decorator factory
    return <T extends ModelClassType>(target: T) => applyModelDecorator(target, targetOrEntityName);
  }
  // Called as @model - apply directly
  return applyModelDecorator(targetOrEntityName);
}
