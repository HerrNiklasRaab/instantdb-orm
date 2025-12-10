// Map from ModelClass → Map<schemaFieldName, backingFieldName>
const PRIVATE_FIELD_REGISTRY = new Map<Function, Map<string, string>>();

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
  return function (target: any, backingFieldName: string): void {
    // Handle potential undefined target during decorator initialization
    const ModelClass = target?.constructor ?? target;

    if (!ModelClass) {
      console.warn(`@field decorator called with invalid target for field: ${backingFieldName}`);
      return;
    }

    const attributeName =
      options?.attributeName ??
      (backingFieldName.startsWith("_") ? backingFieldName.slice(1) : backingFieldName);

    if (!PRIVATE_FIELD_REGISTRY.has(ModelClass)) {
      PRIVATE_FIELD_REGISTRY.set(ModelClass, new Map());
    }
    PRIVATE_FIELD_REGISTRY.get(ModelClass)!.set(attributeName, backingFieldName);
  };
}

/**
 * Get the backing field name for a schema field, if registered via @field decorator.
 */
export function getBackingFieldName(
  ModelClass: Function,
  schemaField: string
): string | undefined {
  // Check this class and its prototype chain
  let current: Function | null = ModelClass;
  while (current && current !== Object) {
    const fields = PRIVATE_FIELD_REGISTRY.get(current);
    if (fields?.has(schemaField)) {
      return fields.get(schemaField);
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}
