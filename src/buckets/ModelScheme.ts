import type { Row } from "../queries";
import type { BucketKey } from "./BucketKey";
import type { BucketRule } from "./BucketRule";
import { BucketEntry } from "./BucketEntry";
import type { ParameterQueries } from "./ParameterQueries";

// FNV-1a over the rule structure: stable across processes, no crypto dependency
// in a module the client may bundle.
function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x811c9dc5) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** How one model's rows are filed into buckets, as compiled from its read policies. */
export class ModelScheme {
  readonly dependencies: readonly string[];
  readonly generation: string;

  constructor(
    readonly model: string,
    readonly rules: readonly BucketRule[],
  ) {
    this.dependencies = [...new Set(rules.flatMap((rule) => rule.dependencies))].sort();
    this.generation = fingerprint(JSON.stringify(rules));
  }

  /** The buckets a row of this model is filed under. */
  keysFor(row: Row): BucketKey[] {
    const keys: BucketKey[] = [];
    for (const rule of this.rules) {
      const key = rule.keyFor(this.model, row);
      if (key) keys.push(key);
    }
    return keys;
  }

  async heldKeys(identityId: string | null, queries: ParameterQueries): Promise<BucketKey[]> {
    const keys: BucketKey[] = [];
    for (const rule of this.rules) keys.push(...await rule.heldKeys(this.model, identityId, queries));
    return keys;
  }

  /** What a change of one row means for the buckets: entered, left, or changed in place. */
  entriesFor(entityId: string, before: Row | undefined, after: Row | undefined): BucketEntry[] {
    const wasIn = new Set((before ? this.keysFor(before) : []).map(String));
    const isIn = new Set((after ? this.keysFor(after) : []).map(String));
    const entries: BucketEntry[] = [];
    for (const bucket of wasIn) {
      if (!isIn.has(bucket)) entries.push(new BucketEntry(bucket, this.model, entityId, true));
    }
    for (const bucket of isIn) entries.push(new BucketEntry(bucket, this.model, entityId, false));
    return entries;
  }

  /** The identities whose held keys a change to a row of `dependency` may alter: the rows name them. */
  identitiesNamedBy(dependency: string, rows: readonly Row[]): string[] {
    const identities: string[] = [];
    for (const rule of this.rules) {
      if (rule.kind !== "relation" || rule.parameter.model !== dependency) continue;
      for (const row of rows) {
        const identity: unknown = row[rule.parameter.identityColumn];
        if (typeof identity === "string") identities.push(identity);
      }
    }
    return identities;
  }
}
