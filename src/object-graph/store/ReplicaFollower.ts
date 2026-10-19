import { observable, runInAction } from "mobx";
import type { ReplicaChange, SyncClient } from "../../client";
import type { Row, UntypedQuery } from "../../queries";
import type { Unsubscribe } from "../../subscriptions";

/** The store as its follower sees it: which models to hold, how to read them, where rows go. */
export interface ReplicaMirror {
  entities(): readonly string[];
  /** A read of `entity`, narrowed by `where`, with every link hydration wires. */
  queryFor(entity: string, where?: Record<string, unknown>): UntypedQuery;
  hydrate(entity: string, rows: Row[]): void;
  /** The model's rows as the replica holds all of them: models no longer listed leave. */
  hydrateWhole(entity: string, rows: Row[]): void;
  evict(entity: string, ids: readonly string[]): void;
  failed(error: unknown): void;
}

function rowsOf(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((row): row is Row => typeof row === "object" && row !== null) : [];
}

/**
 * Keeps a store's models in step with its client's replica: everything once
 * the first sync is in, then exactly the rows each server message wrote or
 * removed, one message after the other.
 */
export class ReplicaFollower {
  private tail: Promise<void> = Promise.resolve();
  private readonly loaded = observable.box(false);
  private stopListening: Unsubscribe | null = null;

  constructor(
    private readonly client: SyncClient,
    private readonly mirror: ReplicaMirror,
  ) {}

  start(): void {
    this.stopListening = this.client.onReplicaChanged((change) => {
      this.enqueue(() => this.apply(change));
    });
    this.enqueue(async () => {
      await this.client.ready();
      for (const entity of this.mirror.entities()) await this.loadWhole(entity);
      runInAction(() => { this.loaded.set(true); });
    });
  }

  /** True once everything the first sync brought is in the store. Observable. */
  get synced(): boolean {
    return this.loaded.get();
  }

  /** Resolves once every change reported so far is in the store. */
  idle(): Promise<void> {
    return this.tail;
  }

  stop(): void {
    this.stopListening?.();
    this.stopListening = null;
  }

  private enqueue(job: () => Promise<void>): void {
    this.tail = this.tail.then(job).catch((error: unknown) => { this.mirror.failed(error); });
  }

  private async apply(change: ReplicaChange): Promise<void> {
    const followed = new Set(this.mirror.entities());
    for (const model of change.models()) {
      if (followed.has(model)) await this.loadWhole(model);
    }
    for (const [entity, ids] of change.writtenIds()) {
      if (!followed.has(entity)) continue;
      const result = await this.client.read(this.mirror.queryFor(entity, { id: { in: ids } }));
      this.mirror.hydrate(entity, rowsOf(result[entity]));
    }
    for (const [entity, ids] of change.removedIds()) {
      if (followed.has(entity)) this.mirror.evict(entity, ids);
    }
  }

  private async loadWhole(entity: string): Promise<void> {
    const result = await this.client.read(this.mirror.queryFor(entity));
    this.mirror.hydrateWhole(entity, rowsOf(result[entity]));
  }
}
