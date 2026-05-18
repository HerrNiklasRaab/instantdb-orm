const PRIVATE_FIELD_REGISTRY = new Map<object, Map<string, string>>();

type DecoratorTarget = object | undefined;
type DecoratorContext = string | symbol | { name: string | symbol };

/**
 * Decorator to declare a private backing field for a schema attribute.
 * Apply to the private field. If attributeName is omitted, it's derived
 * from the backing field name by removing the leading underscore.
 *
 * @example
 * class ChessMatch extends Model {
 *   @field()  // attributeName inferred as "timeControl"
 *   private _timeControl: string;
 *
 *   @field({ attributeName: "customName" })  // explicit override
 *   private _foo: string;
 * }
 */
export function field(options?: { attributeName?: string }) {
  return function (target: DecoratorTarget, context: DecoratorContext): void {
    const propertyName = typeof context === "object"
      ? String(context.name)
      : String(context);

    let candidate: unknown = target;
    if (target) {
      const fromCtor: unknown = Reflect.get(target, "constructor");
      if (fromCtor !== undefined) candidate = fromCtor;
    }
    if (typeof candidate !== "function") return;
    const ModelClass: object = candidate;

    const attributeName =
      options?.attributeName ??
      (propertyName.startsWith("_") ? propertyName.slice(1) : propertyName);

    let fields = PRIVATE_FIELD_REGISTRY.get(ModelClass);
    if (!fields) {
      fields = new Map();
      PRIVATE_FIELD_REGISTRY.set(ModelClass, fields);
    }
    fields.set(attributeName, propertyName);
  };
}

/**
 * Get the backing field name for a schema field, if registered via @field decorator.
 */
export function getBackingFieldName(
  ModelClass: object,
  schemaField: string
): string | undefined {
  let current: object | null = ModelClass;
  while (current && current !== Object) {
    const fields = PRIVATE_FIELD_REGISTRY.get(current);
    if (fields?.has(schemaField)) {
      return fields.get(schemaField);
    }
    const proto: unknown = Object.getPrototypeOf(current);
    current =
      proto !== null && (typeof proto === "object" || typeof proto === "function")
        ? proto
        : null;
  }
  return undefined;
}
