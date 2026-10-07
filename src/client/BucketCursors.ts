import type { ZenStackModels } from "../schema/DatabaseClient";
import type { BucketKey } from "../buckets/BucketKey";
import type { BucketCursor } from "../protocol";
import { replicaClientOf, type ReplicaClient } from "../schema/replicaClient";

/** A bucket this replica held: enough to find its rows locally once it is gone. */
export class HeldBucket {
  constructor(
    readonly model: string,
    readonly filter: Record<string, unknown>,
  ) {}
}

/** Where this replica stands in each bucket it holds, in SQLite so a restart resumes rather than re-downloads. */
export class BucketCursors {
  private readonly local: ReplicaClient;

  constructor(client: ZenStackModels) {
    this.local = replicaClientOf(client);
  }

  async all(): Promise<BucketCursor[]> {
    return this.local.bucketCursors.findMany({ select: { bucket: true, model: true, tick: true } });
  }

  /** Per model, the policy generation its rows were downloaded under. */
  async generations(): Promise<Record<string, string>> {
    const rows = await this.local.bucketCursors.findMany({ select: { model: true, generation: true } });
    return Object.fromEntries(rows.map((row) => [row.model, row.generation]));
  }

  async set(key: BucketKey, tick: number, generation: string): Promise<void> {
    const data = { model: key.model, filter: key.filter(), tick, generation };
    await this.local.bucketCursors.upsert({
      where: { bucket: key.toString() },
      create: { bucket: key.toString(), ...data },
      update: data,
    });
  }

  async advance(buckets: readonly string[], tick: number): Promise<void> {
    await this.local.bucketCursors.updateMany({
      where: { bucket: { in: [...buckets] }, tick: { lt: tick } },
      data: { tick },
    });
  }

  /** Forgets the bucket and says which rows it stood for. */
  async take(bucket: string): Promise<HeldBucket | null> {
    const row = await this.local.bucketCursors.findUnique({ where: { bucket } });
    if (!row) return null;
    await this.local.bucketCursors.delete({ where: { bucket } });
    return new HeldBucket(row.model, isFilter(row.filter) ? row.filter : {});
  }

  async forgetModel(model: string): Promise<void> {
    await this.local.bucketCursors.deleteMany({ where: { model } });
  }
}

function isFilter(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
