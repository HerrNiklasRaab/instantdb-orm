type FieldTypeRef = abstract new (...args: never[]) => unknown;

export interface FieldDescriptor {
  propertyName: string;
  attributeName: string;
  type?: FieldTypeRef;
  optional: boolean;
}

export interface FieldOptions {
  attributeName?: string;
  type?: FieldTypeRef;
  optional?: boolean;
}

type MemberDecoratorContext =
  | ClassFieldDecoratorContext
  | ClassAccessorDecoratorContext
  | ClassGetterDecoratorContext;

const FIELDS_KEY = Symbol.for("@upfor/sync.fieldDescriptors");
const PRIVATE_FIELDS_KEY = Symbol.for("@upfor/sync.privateFieldNames");

/**
 * Both Babel's and SWC's stage-3 decorator helpers key the per-class metadata
 * object on the class via `Symbol.for("Symbol.metadata")` — a registered
 * symbol used as a portable polyfill until JS engines ship the well-known
 * `Symbol.metadata` natively. Looking up via the same registered symbol gives
 * us access to the metadata regardless of engine support.
 */
const METADATA_SYMBOL = Symbol.for("Symbol.metadata");

interface FieldMetadata {
  [FIELDS_KEY]?: Map<string, FieldDescriptor>;
  [PRIVATE_FIELDS_KEY]?: Map<string, string>;
}

function isFieldMetadata(value: unknown): value is FieldMetadata {
  return value !== null && typeof value === "object";
}

function ownFields(meta: FieldMetadata): Map<string, FieldDescriptor> {
  if (Object.hasOwn(meta, FIELDS_KEY)) {
    const existing = meta[FIELDS_KEY];
    if (existing) return existing;
  }
  const map = new Map<string, FieldDescriptor>();
  meta[FIELDS_KEY] = map;
  return map;
}

function ownPrivateFields(meta: FieldMetadata): Map<string, string> {
  if (Object.hasOwn(meta, PRIVATE_FIELDS_KEY)) {
    const existing = meta[PRIVATE_FIELDS_KEY];
    if (existing) return existing;
  }
  const map = new Map<string, string>();
  meta[PRIVATE_FIELDS_KEY] = map;
  return map;
}

/**
 * Walks the class prototype chain and yields each class's own metadata.
 *
 * NOT the metadata's prototype chain. SWC's stage-3 helper creates a fresh
 * `Object.create(null)` for the metadata of each decorated class instead of
 * linking it to the parent class's metadata, so walking via
 * `Object.getPrototypeOf(metadata)` skips ancestors with their own decorated
 * members. Walking the class hierarchy directly keeps the lookup correct
 * regardless of helper behavior.
 */
function* walkClassMetadata(cls: object): Generator<FieldMetadata> {
  let current: unknown = cls;
  while (current != null && current !== Function.prototype) {
    const own: unknown = Object.getOwnPropertyDescriptor(current, METADATA_SYMBOL)?.value;
    if (isFieldMetadata(own)) yield own;
    current = Object.getPrototypeOf(current);
  }
}

export function field(options?: FieldOptions) {
  return function (_value: undefined, context: MemberDecoratorContext): void {
    if (context.static) return;
    const propertyName = String(context.name);
    const attributeName =
      options?.attributeName ??
      (propertyName.startsWith("_") ? propertyName.slice(1) : propertyName);

    const descriptor: FieldDescriptor = {
      propertyName,
      attributeName,
      optional: options?.optional ?? false,
    };
    if (options?.type) descriptor.type = options.type;

    if (!isFieldMetadata(context.metadata)) return;
    ownFields(context.metadata).set(propertyName, descriptor);
    ownPrivateFields(context.metadata).set(attributeName, propertyName);
  };
}

export function getBackingFieldName(
  ModelClass: object,
  schemaField: string
): string | undefined {
  for (const m of walkClassMetadata(ModelClass)) {
    if (!Object.hasOwn(m, PRIVATE_FIELDS_KEY)) continue;
    const own = m[PRIVATE_FIELDS_KEY];
    if (own?.has(schemaField)) return own.get(schemaField);
  }
  return undefined;
}

export function getFieldDescriptor(
  Cls: object,
  propertyName: string
): FieldDescriptor | undefined {
  for (const m of walkClassMetadata(Cls)) {
    if (!Object.hasOwn(m, FIELDS_KEY)) continue;
    const own = m[FIELDS_KEY];
    if (own?.has(propertyName)) return own.get(propertyName);
  }
  return undefined;
}

export function collectFieldDescriptors(Cls: object): FieldDescriptor[] {
  const chain: FieldMetadata[] = [];
  for (const m of walkClassMetadata(Cls)) chain.unshift(m);
  const out = new Map<string, FieldDescriptor>();
  for (const m of chain) {
    if (!Object.hasOwn(m, FIELDS_KEY)) continue;
    const own = m[FIELDS_KEY];
    if (!own) continue;
    for (const [name, desc] of own) {
      out.set(name, desc);
    }
  }
  return [...out.values()];
}
