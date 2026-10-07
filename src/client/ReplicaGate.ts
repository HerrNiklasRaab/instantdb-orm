/**
 * Keeps reads of the replica out of the middle of a write. Each server
 * message and each local transaction is written as several SQLite
 * statements, and a device's driver hands the event loop back between them:
 * without the gate a read could see half a transaction. Writes run one at a
 * time and wait for reads under way; reads wait for every write already
 * queued.
 */
export class ReplicaGate {
  private writes: Promise<void> = Promise.resolve();
  private readonly reading = new Set<Promise<unknown>>();

  async read<T>(work: () => Promise<T>): Promise<T> {
    await this.writes;
    const running = work();
    this.reading.add(running);
    try {
      return await running;
    } finally {
      this.reading.delete(running);
    }
  }

  write<T>(work: () => Promise<T>): Promise<T> {
    const running = this.writes.then(async () => {
      await Promise.allSettled([...this.reading]);
      return work();
    });
    this.writes = running.then(() => undefined, () => undefined);
    return running;
  }
}
