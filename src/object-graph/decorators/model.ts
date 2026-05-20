import { modelRegistry } from "../store/ModelRegistry";
import type { Constructor, ModelConstructor } from "../store/types";
import { ENTITY_NAME_KEY, deriveEntityName } from "./model-utils";

export { ENTITY_NAME_KEY, deriveEntityName } from "./model-utils";

const MODEL_BASE_CLASS_NAME = "Model";

type ModelClassType =
  | (abstract new (...args: never[]) => { id: string })
  | { prototype: { id: string }; name: string };

function readStoredEntityName(cls: object): string | undefined {
  const stored: unknown = Reflect.get(cls, ENTITY_NAME_KEY);
  return typeof stored === "string" ? stored : undefined;
}

function writeStoredEntityName(cls: object, entityName: string): void {
  Reflect.set(cls, ENTITY_NAME_KEY, entityName);
}

function readParentClass(cls: object): Constructor<object> | null {
  const proto: unknown = Object.getPrototypeOf(cls);
  return typeof proto === "function" ? proto : null;
}

/** Get entity name from a class (set by @model decorator) */
export function getEntityNameFromClass(ModelClass: ModelClassType): string {
  const stored = readStoredEntityName(ModelClass);
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
function findRootModelClass(target: ModelClassType): Constructor<object> {
  let current: Constructor<object> = target;
  while (current.name !== MODEL_BASE_CLASS_NAME) {
    const parent = readParentClass(current);
    if (!parent) return target;
    if (parent.name === MODEL_BASE_CLASS_NAME) return current;
    current = parent;
  }
  return target;
}

/**
 * Reads discriminator value from 'modelType' getter on the class prototype.
 * The modelType must be defined as a getter: `get modelType() { return "value"; }`
 */
function getDiscriminatorValue(target: ModelClassType): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target.prototype, "modelType");
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
  const isSubclass = rootClass !== target;

  const entityName = explicitEntityName ?? deriveEntityName(rootClass.name);
  writeStoredEntityName(target, entityName);

  if (isSubclass) {
    const discriminatorValue = getDiscriminatorValue(target);
    if (discriminatorValue) {
      modelRegistry.registerDiscriminator(entityName, discriminatorValue, target);
    } else {
      const ownEntityName = explicitEntityName ?? deriveEntityName(target.name);
      writeStoredEntityName(target, ownEntityName);
      modelRegistry.register(ownEntityName, target);
    }
  } else {
    modelRegistry.register(entityName, target);
  }

  let parent = readParentClass(target);
  while (parent && parent.name !== MODEL_BASE_CLASS_NAME) {
    if (isModelConstructor(parent)) {
      modelRegistry.registerSubclass(parent, target);
    }
    parent = readParentClass(parent);
  }

  return target;
}

function isModelConstructor(value: Constructor<object>): value is ModelConstructor {
  return typeof value === "function" && "prototype" in value;
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
