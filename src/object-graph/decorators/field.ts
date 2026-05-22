const PRIVATE_FIELD_REGISTRY = new Map<object, Map<string, string>>();

type FieldTypeRef = abstract new (...args: never[]) => unknown;

export interface FieldDescriptor {
  propertyName: string;
  attributeName: string;
  type?: FieldTypeRef;
  optional: boolean;
}

const FIELD_DESCRIPTOR_REGISTRY = new Map<object, Map<string, FieldDescriptor>>();

type DecoratorTarget = object | undefined;
type DecoratorContext = string | symbol | { name: string | symbol };

export interface FieldOptions {
  attributeName?: string;
  type?: FieldTypeRef;
  optional?: boolean;
}

export function field(options?: FieldOptions) {
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
    const ModelClass = candidate;

    const attributeName =
      options?.attributeName ??
      (propertyName.startsWith("_") ? propertyName.slice(1) : propertyName);

    let fields = PRIVATE_FIELD_REGISTRY.get(ModelClass);
    if (!fields) {
      fields = new Map();
      PRIVATE_FIELD_REGISTRY.set(ModelClass, fields);
    }
    fields.set(attributeName, propertyName);

    let descriptors = FIELD_DESCRIPTOR_REGISTRY.get(ModelClass);
    if (!descriptors) {
      descriptors = new Map();
      FIELD_DESCRIPTOR_REGISTRY.set(ModelClass, descriptors);
    }
    const descriptor: FieldDescriptor = {
      propertyName,
      attributeName,
      optional: options?.optional ?? false,
    };
    if (options?.type) descriptor.type = options.type;
    descriptors.set(propertyName, descriptor);
  };
}

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

export function getFieldDescriptor(
  Cls: object,
  propertyName: string
): FieldDescriptor | undefined {
  let current: object | null = Cls;
  while (current && current !== Object) {
    const descriptors = FIELD_DESCRIPTOR_REGISTRY.get(current);
    if (descriptors?.has(propertyName)) {
      return descriptors.get(propertyName);
    }
    const proto: unknown = Object.getPrototypeOf(current);
    current =
      proto !== null && (typeof proto === "object" || typeof proto === "function")
        ? proto
        : null;
  }
  return undefined;
}

export function collectFieldDescriptors(Cls: object): FieldDescriptor[] {
  const out = new Map<string, FieldDescriptor>();
  const chain: object[] = [];
  let current: object | null = Cls;
  while (current && current !== Object) {
    chain.unshift(current);
    const proto: unknown = Object.getPrototypeOf(current);
    current =
      proto !== null && (typeof proto === "object" || typeof proto === "function")
        ? proto
        : null;
  }
  for (const c of chain) {
    const descriptors = FIELD_DESCRIPTOR_REGISTRY.get(c);
    if (!descriptors) continue;
    for (const [propertyName, descriptor] of descriptors) {
      out.set(propertyName, descriptor);
    }
  }
  return [...out.values()];
}
