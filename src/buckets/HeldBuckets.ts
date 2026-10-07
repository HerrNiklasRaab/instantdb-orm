import { BucketKey } from "./BucketKey";
import type { BucketScheme } from "./BucketScheme";
import type { ParameterQueries } from "./ParameterQueries";

export class HeldDiff {
  constructor(
    readonly added: readonly BucketKey[],
    readonly removed: readonly BucketKey[],
  ) {}
}

/** The buckets one connection holds: what it is told about, and what it catches up on. */
export class HeldBuckets {
  private readonly byName: ReadonlyMap<string, BucketKey>;

  private constructor(
    keys: readonly BucketKey[],
    /** An unrestricted connection holds every bucket there is, named or not. */
    private readonly everything: boolean,
  ) {
    this.byName = new Map(keys.map((key) => [key.toString(), key]));
  }

  static all(scheme: BucketScheme): HeldBuckets {
    return new HeldBuckets(scheme.modelNames().map((model) => BucketKey.whole(model)), true);
  }

  static async of(scheme: BucketScheme, identityId: string | null, queries: ParameterQueries): Promise<HeldBuckets> {
    return new HeldBuckets(await scheme.heldKeys(identityId, queries), false);
  }

  holds(bucket: string): boolean {
    return this.everything || this.byName.has(bucket);
  }

  get holdsEverything(): boolean {
    return this.everything;
  }

  keys(): BucketKey[] {
    return [...this.byName.values()];
  }

  names(): Set<string> {
    return new Set(this.byName.keys());
  }

  diff(previous: HeldBuckets): HeldDiff {
    return new HeldDiff(
      this.keys().filter((key) => !previous.byName.has(key.toString())),
      previous.keys().filter((key) => !this.byName.has(key.toString())),
    );
  }
}
