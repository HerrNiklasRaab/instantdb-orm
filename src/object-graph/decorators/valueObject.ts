export interface ValueObjectOptions {
  json?: boolean;
}

type ValueObjectCtor = { prototype: ValueObject; readonly name: string };

export function valueObject(_options?: ValueObjectOptions) {
  return function <T extends ValueObjectCtor>(target: T): T {
    return target;
  };
}

export abstract class ValueObject {
  equals(_other: unknown): boolean {
    throw new Error("ValueObject.equals: not implemented");
  }
}
