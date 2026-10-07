import type { UntypedClient } from "./UntypedClient";

/** A many-to-many link: its rows live in the relation's join table, which ZenStack writes through `connect`. */
export class ManyToManyLink {
  constructor(
    private readonly entity: string,
    private readonly field: string,
  ) {}

  async link(db: UntypedClient, id: string, targetIds: readonly string[]): Promise<void> {
    await db.model(this.entity).update({
      where: { id },
      data: { [this.field]: { connect: targetIds.map((targetId) => ({ id: targetId })) } },
    });
  }

  async unlink(db: UntypedClient, id: string, targetIds: readonly string[]): Promise<void> {
    await db.model(this.entity).update({
      where: { id },
      data: { [this.field]: { disconnect: targetIds.map((targetId) => ({ id: targetId })) } },
    });
  }
}
