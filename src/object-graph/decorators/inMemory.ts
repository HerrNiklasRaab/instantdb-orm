type Factory<T> = () => T;
type DefaultValue<T> = T | Factory<T>;

const METADATA_SYMBOL = Symbol.for("Symbol.metadata");

type MemberDecoratorContext =
  | ClassFieldDecoratorContext
  | ClassAccessorDecoratorContext;

const IN_MEMORY_KEY = Symbol.for("@upfor/sync.inMemoryDefaults");

interface InMemoryMetadata {
  [IN_MEMORY_KEY]?: Map<string, Factory<unknown>>;
}

function isInMemoryMetadata(value: unknown): value is InMemoryMetadata {
  return value !== null && typeof value === "object";
}

function ownDefaults(meta: InMemoryMetadata): Map<string, Factory<unknown>> {
  if (Object.hasOwn(meta, IN_MEMORY_KEY)) {
    const existing = meta[IN_MEMORY_KEY];
    if (existing) return existing;
  }
  const map = new Map<string, Factory<unknown>>();
  meta[IN_MEMORY_KEY] = map;
  return map;
}

export function inMemory<T>(defaultValue: DefaultValue<T>) {
  return function (_value: undefined, context: MemberDecoratorContext): void {
    if (context.static) return;
    const factory: Factory<T> = isFactory(defaultValue)
      ? defaultValue
      : () => defaultValue;
    if (!isInMemoryMetadata(context.metadata)) return;
    ownDefaults(context.metadata).set(String(context.name), factory);
  };
}

function isFactory<T>(value: DefaultValue<T>): value is Factory<T> {
  return typeof value === "function";
}

export function applyInMemoryDefaults(instance: object): void {
  const ctor: unknown = Reflect.get(instance, "constructor");
  if (typeof ctor !== "function") return;
  const metadata: unknown = Reflect.get(ctor, METADATA_SYMBOL);
  if (!isInMemoryMetadata(metadata)) return;
  let current: unknown = metadata;
  while (isInMemoryMetadata(current) && current !== Object.prototype) {
    if (Object.hasOwn(current, IN_MEMORY_KEY)) {
      const own = current[IN_MEMORY_KEY];
      if (own) {
        for (const [propertyName, factory] of own) {
          if (Reflect.get(instance, propertyName) === undefined) {
            Reflect.set(instance, propertyName, factory());
          }
        }
      }
    }
    current = Object.getPrototypeOf(current);
  }
}
