import { modelRegistry } from "../store/ModelRegistry";
import type { Constructor, ModelConstructor } from "../store/types";
import { ENTITY_NAME_KEY, deriveEntityName, isModelBaseClass } from "./model-utils";

export { ENTITY_NAME_KEY, deriveEntityName } from "./model-utils";

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

export function getEntityNameFromClass(ModelClass: ModelClassType): string {
  const stored = readStoredEntityName(ModelClass);
  if (!stored) {
    throw new Error(
      `Model class ${ModelClass.name} has no entity name. Did you add @model decorator?`
    );
  }
  return stored;
}

function findRootModelClass(target: ModelClassType): Constructor<object> {
  let current: Constructor<object> = target;
  while (!isModelBaseClass(current)) {
    const parent = readParentClass(current);
    if (!parent) return target;
    if (isModelBaseClass(parent)) return current;
    current = parent;
  }
  return target;
}

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
  while (parent && !isModelBaseClass(parent)) {
    if (isModelConstructor(parent)) {
      modelRegistry.registerSubclass(parent, target);
    }
    parent = readParentClass(parent);
  }

  return target;
}

function isModelConstructor(value: unknown): value is ModelConstructor {
  return typeof value === "function" && "prototype" in value;
}

type LooseClassDecorator<T> = (target: T, context: object) => T;

/**
 * Registers a model class in the registry.
 * Derives entity name from class name: User → "users"
 * Or accepts explicit entity name: @model("users")
 * For STI subclasses, derives entity name from root domain class.
 *
 * Decorator type intentionally uses a loose `context: object` so classes with
 * private constructors (e.g. hydration-only models) can be decorated. TS's
 * `ClassDecoratorContext<T>` strictly requires `T extends abstract new (...args)
 * => any`, which excludes private-constructor classes.
 */
export function model<T>(target: T, context: object): T;
export function model(entityName: string): <T>(target: T, context: object) => T;
export function model<T>(
  targetOrEntityName: T | string,
  _context?: object,
): T | LooseClassDecorator<T> {
  if (typeof targetOrEntityName === "string") {
    const entityName = targetOrEntityName;
    return (target, _ctx) => {
      if (!isModelConstructor(target)) {
        throw new Error("@model can only decorate a class");
      }
      applyModelDecorator(target, entityName);
      return target;
    };
  }
  if (!isModelConstructor(targetOrEntityName)) {
    throw new Error("@model can only decorate a class");
  }
  applyModelDecorator(targetOrEntityName);
  return targetOrEntityName;
}

