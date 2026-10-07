export type KeyValue = string | number | boolean;

export class KeyPart {
  constructor(
    readonly column: string,
    readonly value: KeyValue,
  ) {}
}

export interface BucketKeyJson {
  readonly model: string;
  readonly parts: readonly { readonly column: string; readonly value: KeyValue }[];
}

/**
 * Names one bucket: the rows of `model` whose `parts` columns carry these
 * values; no parts means the whole model. Both sides compute keys on their
 * own, so the string form is the contract between them.
 */
export class BucketKey {
  constructor(
    readonly model: string,
    readonly parts: readonly KeyPart[],
  ) {}

  static whole(model: string): BucketKey {
    return new BucketKey(model, []);
  }

  static fromJson(json: BucketKeyJson): BucketKey {
    return new BucketKey(json.model, json.parts.map((part) => new KeyPart(part.column, part.value)));
  }

  toString(): string {
    return [this.model, ...this.parts.map((part) => `${part.column}[${String(part.value)}]`)].join("/");
  }

  toJSON(): BucketKeyJson {
    return { model: this.model, parts: this.parts.map((part) => ({ column: part.column, value: part.value })) };
  }

  /** The `where` that selects this bucket's rows, on either side. */
  filter(): Record<string, KeyValue> {
    return Object.fromEntries(this.parts.map((part) => [part.column, part.value]));
  }
}
