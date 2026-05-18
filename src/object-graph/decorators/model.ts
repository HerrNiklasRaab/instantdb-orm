import { modelRegistry } from "../store/ModelRegistry";
import type { ModelConstructor } from "../store/types";
import { ENTITY_NAME_KEY, deriveEntityName } from "./model-utils";

export { ENTITY_NAME_KEY, deriveEntityName } from "./model-utils";

type ModelClassType = (abstract new (...args: never[]) => { id: string })
  | { prototype: { id: string }; name: string };

function getClassName(cls: object): string {
  const name: unknown = Reflect.get(cls, "name");
  return typeof name === "string" ? name : "";
}

function readStoredEntityName(cls: object): string | undefined {
  const stored: unknown = Reflect.get(cls, ENTITY_NAME_KEY);
  return typeof stored === "string" ? stored : undefined;
}

function writeStoredEntityName(cls: object, entityName: string): void {
  Reflect.set(cls, ENTITY_NAME_KEY, entityName);
}

function readPrototype(cls: object): object | null {
  const proto: unknown = Object.getPrototypeOf(cls);
  if (proto === null) return null;
  if (typeof proto !== "object" && typeof proto !== "function") return null;
  return proto;
}

/** Get entity name from a class (set by @model decorator) */
export function getEntityNameFromClass(
  ModelClass: ModelClassType
): string {
  const stored = readStoredEntityName(ModelClass);
  if (!stored) {
    throw new Error(
      `Model class ${getClassName(ModelClass)} has no entity name. Did you add @model decorator?`
    );
  }
  return stored;
}

/**
 * Finds the root domain class (first class in prototype chain whose parent is Model).
 * For STI, this determines the shared table name.
 * Uses name comparison to avoid circular import with Model.ts.
 */
function findRootModelClass(target: ModelClassType): object {
  let current: object | null = target;
  while (current && getClassName(current) !== "Model") {
    const parent = readPrototype(current);
    if (parent && getClassName(parent) === "Model") {
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
  const proto: unknown = Reflect.get(target, "prototype");
  if (proto === null || (typeof proto !== "object" && typeof proto !== "function")) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(proto, "modelType");
  if (!descriptor) return undefined;

  if (typeof descriptor.get === "function") {
    const value: unknown = descriptor.get.call(null);
    return typeof value === "string" ? value : undefined;
  }

  const value: unknown = descriptor.value;
  return typeof value === "string" ? value : undefined;
}

/**
 * Internal helper that applies the @model decorator logic.
 */
function applyModelDecorator<T extends ModelConstructor>(
  target: T,
  explicitEntityName?: string
): T {
  const rootClass = findRootModelClass(target);
  const isSubclass = rootClass !== (target as object);

  const entityName = explicitEntityName ?? deriveEntityName(getClassName(rootClass));
  writeStoredEntityName(target, entityName);

  if (isSubclass) {
    const discriminatorValue = getDiscriminatorValue(target);
    if (discriminatorValue) {
      modelRegistry.registerDiscriminator(entityName, discriminatorValue, target);
    } else {
      const ownEntityName = explicitEntityName ?? deriveEntityName(getClassName(target));
      writeStoredEntityName(target, ownEntityName);
      modelRegistry.register(ownEntityName, target);
    }
  } else {
    modelRegistry.register(entityName, target);
  }

  let parent = readPrototype(target);
  while (parent && getClassName(parent) !== "Model") {
    if (isModelConstructor(parent)) {
      modelRegistry.registerSubclass(parent, target);
    }
    parent = readPrototype(parent);
  }

  return target;
}

function isModelConstructor(value: object): value is ModelConstructor {
  return typeof value === "function";
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
export function model<T extends ModelConstructor>(target: T): T;
export function model(entityName: string): <T extends ModelConstructor>(target: T) => T;
export function model(
  targetOrEntityName: ModelConstructor | string
): ModelConstructor | (<T extends ModelConstructor>(target: T) => T) {
  if (typeof targetOrEntityName === "string") {
    // Called as @model("entityName") - return decorator factory
    return <T extends ModelConstructor>(target: T) => applyModelDecorator(target, targetOrEntityName);
  }
  // Called as @model - apply directly
  return applyModelDecorator(targetOrEntityName);
}
