import type { Row } from "../queries";
import { BucketKey, KeyPart, type KeyValue } from "./BucketKey";
import type { ParameterQueries } from "./ParameterQueries";

/** "Which keys does the user hold": the rows of `model` where `identityColumn` is the user, keyed by `keyColumn`. */
export class ParameterQuery {
  constructor(
    readonly model: string,
    readonly identityColumn: string,
    readonly keyColumn: string,
  ) {}
}

export class ColumnKey {
  constructor(
    readonly column: string,
    /** Path on the auth user whose value the holder compares with, `id` or `team.id`. */
    readonly authField: string,
  ) {}

  partOf(row: Row): KeyPart | null {
    const value: unknown = row[this.column];
    return isKeyValue(value) ? new KeyPart(this.column, value) : null;
  }

  heldPart(identityId: string): KeyPart {
    if (this.authField !== "id") {
      throw new Error(`Bucket keys on auth().${this.authField} are not supported yet; only auth().id is.`);
    }
    return new KeyPart(this.column, identityId);
  }
}

function isKeyValue(value: unknown): value is KeyValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Every row of the model is filed under one key that every user holds. */
export class GlobalBucket {
  readonly kind = "global" as const;

  /** Why a keyed rule was not possible; null when the rule is simply row-only. */
  constructor(readonly reason: string | null) {}

  get dependencies(): readonly string[] {
    return [];
  }

  keyFor(model: string): BucketKey {
    return BucketKey.whole(model);
  }

  heldKeys(model: string): Promise<BucketKey[]> {
    return Promise.resolve([BucketKey.whole(model)]);
  }
}

export class ColumnBucket {
  readonly kind = "column" as const;
  readonly column: string;
  readonly authField: string;

  constructor(key: ColumnKey) {
    this.column = key.column;
    this.authField = key.authField;
  }

  // Derived, not stored: the rule is compared structurally and fingerprinted.
  private get key(): ColumnKey {
    return new ColumnKey(this.column, this.authField);
  }

  get dependencies(): readonly string[] {
    return [];
  }

  keyFor(model: string, row: Row): BucketKey | null {
    const part = this.key.partOf(row);
    return part ? new BucketKey(model, [part]) : null;
  }

  heldKeys(model: string, identityId: string | null): Promise<BucketKey[]> {
    if (identityId === null) return Promise.resolve([]);
    return Promise.resolve([new BucketKey(model, [this.key.heldPart(identityId)])]);
  }
}

export class TupleBucket {
  readonly kind = "tuple" as const;

  constructor(readonly parts: readonly ColumnKey[]) {}

  get dependencies(): readonly string[] {
    return [];
  }

  keyFor(model: string, row: Row): BucketKey | null {
    const parts: KeyPart[] = [];
    for (const key of this.parts) {
      const part = key.partOf(row);
      if (!part) return null;
      parts.push(part);
    }
    return new BucketKey(model, parts);
  }

  heldKeys(model: string, identityId: string | null): Promise<BucketKey[]> {
    if (identityId === null) return Promise.resolve([]);
    return Promise.resolve([new BucketKey(model, this.parts.map((key) => key.heldPart(identityId)))]);
  }
}

/** Keyed by a column of the row; the holder's keys come from `parameter`. */
export class RelationBucket {
  readonly kind = "relation" as const;

  constructor(
    readonly column: string,
    readonly parameter: ParameterQuery,
  ) {}

  get dependencies(): readonly string[] {
    return [this.parameter.model];
  }

  keyFor(model: string, row: Row): BucketKey | null {
    const value: unknown = row[this.column];
    return isKeyValue(value) ? new BucketKey(model, [new KeyPart(this.column, value)]) : null;
  }

  async heldKeys(model: string, identityId: string | null, queries: ParameterQueries): Promise<BucketKey[]> {
    if (identityId === null) return [];
    const values = await queries.values(this.parameter, identityId);
    return values.map((value) => new BucketKey(model, [new KeyPart(this.column, value)]));
  }
}

export type BucketRule = GlobalBucket | ColumnBucket | TupleBucket | RelationBucket;
