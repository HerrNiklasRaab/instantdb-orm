import type { ModelDef } from "@zenstackhq/schema";
import type { DatabaseClient } from "../schema/DatabaseClient";

/**
 * One side of an implicit many-to-many relation, in ZenStack's join-table
 * layout: `_<relation name>`, columns A/B ordered by model name (by field
 * name for a self-relation). ZenStack reads these tables by exactly these
 * names but will not create them, so the replica does, and writes link rows
 * into them directly — there is no model to go through.
 */
export class JoinTable {
  private constructor(
    readonly name: string,
    private readonly ownColumn: "A" | "B",
    private readonly otherColumn: "A" | "B",
    /** The entities whose ids columns A and B hold. */
    readonly ends: { readonly A: string; readonly B: string },
  ) {}

  static of(models: Readonly<Record<string, ModelDef>>, entity: string, fieldName: string): JoinTable | null {
    const field = models[entity]?.fields[fieldName];
    const oppositeName = field?.relation?.opposite;
    if (!field?.array || oppositeName === undefined) return null;
    const opposite = models[field.type]?.fields[oppositeName];
    if (!opposite?.array) return null;

    const [firstModel, secondModel] = [entity, field.type].sort();
    const ownIsFirst = entity === field.type
      ? [fieldName, oppositeName].sort()[0] === fieldName
      : firstModel === entity;
    return new JoinTable(
      `_${field.relation?.name ?? `${firstModel}To${secondModel}`}`,
      ownIsFirst ? "A" : "B",
      ownIsFirst ? "B" : "A",
      ownIsFirst ? { A: entity, B: field.type } : { A: field.type, B: entity },
    );
  }

  static all(models: Readonly<Record<string, ModelDef>>): JoinTable[] {
    const byName = new Map<string, JoinTable>();
    for (const [entity, model] of Object.entries(models)) {
      for (const fieldName of Object.keys(model.fields)) {
        const table = JoinTable.of(models, entity, fieldName);
        if (table && !byName.has(table.name)) byName.set(table.name, table);
      }
    }
    return [...byName.values()];
  }

  async ensure(db: DatabaseClient): Promise<void> {
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "${this.name}" ("A" TEXT NOT NULL, "B" TEXT NOT NULL, PRIMARY KEY ("A", "B"))`);
  }

  async add(db: DatabaseClient, ownId: string, otherId: string): Promise<void> {
    await db.$executeRawUnsafe(`INSERT OR IGNORE INTO "${this.name}" ("${this.ownColumn}", "${this.otherColumn}") VALUES (?, ?)`, ownId, otherId);
  }

  async remove(db: DatabaseClient, ownId: string, otherId: string): Promise<void> {
    await db.$executeRawUnsafe(`DELETE FROM "${this.name}" WHERE "${this.ownColumn}" = ? AND "${this.otherColumn}" = ?`, ownId, otherId);
  }

  async clear(db: DatabaseClient, ownId: string): Promise<void> {
    await db.$executeRawUnsafe(`DELETE FROM "${this.name}" WHERE "${this.ownColumn}" = ?`, ownId);
  }
}
