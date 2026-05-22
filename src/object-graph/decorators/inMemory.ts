type Factory<T> = () => T;
type DefaultValue<T> = T | Factory<T>;
type ClassCtor = new (...args: never[]) => unknown;

const IN_MEMORY_FIELD_REGISTRY = new Map<ClassCtor, Map<string, Factory<unknown>>>();

/**
 * Declares a class field that lives in memory only — not persisted, not
 * synced. Hydration bypasses constructors, so initializers on these fields
 * never run; this decorator registers a default the framework re-applies
 * after `Object.create(prototype)` so MobX can observe the property.
 *
 * Pass a value, or a factory for per-instance defaults (e.g. `() => []`).
 *
 * @example
 *   @inMemory(null)
 *   private _activeSessionId: string | null = null;
 *
 *   @inMemory(() => [])
 *   private _localDrafts: Draft[] = [];
 */
export function inMemory<T>(defaultValue: DefaultValue<T>) {
  return function (target: object, propertyKey: string | symbol): void {
    const ModelClass = ctorOf(target);
    if (!ModelClass) return;

    const factory: Factory<T> = isFactory(defaultValue)
      ? defaultValue
      : () => defaultValue;

    let fields = IN_MEMORY_FIELD_REGISTRY.get(ModelClass);
    if (!fields) {
      fields = new Map();
      IN_MEMORY_FIELD_REGISTRY.set(ModelClass, fields);
    }
    fields.set(String(propertyKey), factory);
  };
}

function isFactory<T>(value: DefaultValue<T>): value is Factory<T> {
  return typeof value === "function";
}

function isClassCtor(value: unknown): value is ClassCtor {
  return typeof value === "function";
}

function ctorOf(target: object): ClassCtor | null {
  const ctor: unknown = Reflect.get(target, "constructor");
  return isClassCtor(ctor) ? ctor : null;
}

export function applyInMemoryDefaults(instance: object): void {
  for (const ctor of constructorChain(instance)) {
    const fields = IN_MEMORY_FIELD_REGISTRY.get(ctor);
    if (!fields) continue;
    for (const [propertyName, factory] of fields) {
      if (Reflect.get(instance, propertyName) === undefined) {
        Reflect.set(instance, propertyName, factory());
      }
    }
  }
}

function* constructorChain(instance: object): Generator<ClassCtor> {
  let proto: unknown = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    if (typeof proto !== "object") break;
    const ctor = ctorOf(proto);
    if (ctor) yield ctor;
    proto = Object.getPrototypeOf(proto);
  }
}
