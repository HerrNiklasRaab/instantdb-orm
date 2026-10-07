import type { FieldDef, ModelDef } from "@zenstackhq/schema";
import type { RowLinks } from "../transactions/Transaction";

/** A to-one link a row holds, and the column it is stored in. */
export interface HeldLink {
  readonly field: string;
  readonly column: string;
  /** The entity the link points at. */
  readonly target: string;
}

/**
 * One model's links as its schema stores them: which the row holds in a
 * foreign key of its own, which the linked row holds, and which live in a
 * many-to-many join table.
 */
export class ModelLinks {
  constructor(
    private readonly entity: string,
    private readonly models: Readonly<Record<string, ModelDef>>,
  ) {}

  /** The foreign key this row stores `field` in; `null` when another row or a join table holds it. */
  columnOf(field: string): string | null {
    return this.relation(field)?.relation?.fields?.[0] ?? null;
  }

  /** The entity `field` links to. */
  targetOf(field: string): string | undefined {
    return this.relation(field)?.type;
  }

  /** For a link the linked row holds (`chat.messages`), that row's side of it (`messages.chat`). */
  holderOf(field: string): { entity: string; field: string } | null {
    const def = this.relation(field);
    const opposite = def?.relation?.opposite;
    if (!def || opposite === undefined || this.columnOf(field) !== null) return null;
    return new ModelLinks(def.type, this.models).columnOf(opposite) === null ? null : { entity: def.type, field: opposite };
  }

  isManyToMany(field: string): boolean {
    return this.relation(field) !== undefined && this.columnOf(field) === null && this.holderOf(field) === null;
  }

  /** A link the row holds whose target may be held by no other row. */
  isOneToOne(field: string): boolean {
    const def = this.relation(field);
    const opposite = def?.relation?.opposite;
    if (!def || this.columnOf(field) === null) return false;
    return opposite === undefined || this.models[def.type]?.fields[opposite]?.array !== true;
  }

  /** Every to-one link the row holds. */
  held(): HeldLink[] {
    const held: HeldLink[] = [];
    for (const [field, def] of Object.entries(this.models[this.entity]?.fields ?? {})) {
      const column = this.columnOf(field);
      if (column !== null) held.push({ field, column, target: def.type });
    }
    return held;
  }

  /** A row's own links as the column values they are stored in. */
  foreignKeys(links: RowLinks): Record<string, string | null> {
    const columns: Record<string, string | null> = {};
    for (const [field, target] of Object.entries(links)) {
      const column = this.columnOf(field);
      if (column === null) throw new Error(`"${this.entity}.${field}" is not a link this row holds.`);
      columns[column] = target;
    }
    return columns;
  }

  private relation(field: string): FieldDef | undefined {
    const def = this.models[this.entity]?.fields[field];
    return def?.relation ? def : undefined;
  }
}
