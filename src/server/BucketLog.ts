import type { ZenStackModels } from "../schema/DatabaseClient";
import type { BucketKey } from "../buckets/BucketKey";
import { BucketEntry } from "../buckets/BucketEntry";
import { serverClientOf, type ServerClient } from "../schema/serverClient";

/** The server's record of which bucket every change was filed under, by log tick. */
export class BucketLog {
  private readonly db: ServerClient;

  constructor(unrestricted: ZenStackModels) {
    this.db = serverClientOf(unrestricted);
  }

  async file(tick: number, entries: readonly BucketEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db.bucketLog.createMany({
      data: entries.map((entry) => ({
        bucket: entry.bucket,
        entity: entry.entity,
        entityId: entry.entityId,
        removed: entry.removed,
        tick,
      })),
      skipDuplicates: true,
    });
  }

  /** Everything filed in `key` by transactions after `tick`, grouped by transaction, oldest first. */
  async since(key: BucketKey, tick: number): Promise<BucketEntry[][]> {
    const rows = await this.db.bucketLog.findMany({
      where: key.parts.length === 0
        ? { entity: key.model, tick: { gt: tick } }
        : { bucket: key.toString(), tick: { gt: tick } },
      orderBy: { tick: "asc" },
    });
    const groups = new Map<number, BucketEntry[]>();
    for (const row of rows) {
      const group = groups.get(row.tick) ?? groups.set(row.tick, []).get(row.tick);
      group?.push(new BucketEntry(row.bucket, row.entity, row.entityId, row.removed));
    }
    return [...groups.values()];
  }
}
