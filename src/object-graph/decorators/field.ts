type ClassKey = abstract new (...args: never[]) => object;

const PRIVATE_FIELD_REGISTRY = new Map<ClassKey, Map<string, string>>();

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
    const propertyName = typeof context === "object" && context !== null
      ? String(context.name)
      : String(context);
    const targetAsHolder = target as { constructor?: unknown } | undefined;
    const candidate = targetAsHolder?.constructor ?? target;
    if (!candidate) return;
    const ModelClass = candidate as ClassKey;

    const attributeName =
      options?.attributeName ??
      (propertyName.startsWith("_") ? propertyName.slice(1) : propertyName);

    if (!PRIVATE_FIELD_REGISTRY.has(ModelClass)) {
      PRIVATE_FIELD_REGISTRY.set(ModelClass, new Map());
    }
    PRIVATE_FIELD_REGISTRY.get(ModelClass)!.set(attributeName, propertyName);
  };
}

/**
 * Get the backing field name for a schema field, if registered via @field decorator.
 */
export function getBackingFieldName(
  ModelClass: ClassKey,
  schemaField: string
): string | undefined {
  let current: ClassKey | null = ModelClass;
  while (current && current !== (Object as unknown as ClassKey)) {
    const fields = PRIVATE_FIELD_REGISTRY.get(current);
    if (fields?.has(schemaField)) {
      return fields.get(schemaField);
    }
    current = Object.getPrototypeOf(current) as ClassKey | null;
  }
  return undefined;
}
