import type { ColumnValue } from "../columns/types";
import type { ModelLinks } from "../../schema/ModelLinks";
import { type ChangeOf, type ColumnValues, Transaction } from "../../transactions";
import { getEntityLinkStorage } from "../store/EntityMeta";

interface RowWrite {
  readonly entity: string;
  readonly id: string;
  readonly isNew: boolean;
  values: Record<string, ColumnValue>;
  readonly links: Map<string, string | null>;
}

function keyOf(entity: string, id: string): string {
  return `${entity}\u0000${id}`;
}

/**
 * The writes of one store transaction, gathered per row, turned into a
 * `Transaction` whose changes say what each row is. A link is written on the
 * row that holds it: `message.chat = chat` and `chat.messages.push(message)`
 * both land on the message as `links: { chat }`, whichever side the code
 * touched. Only a many-to-many link, which no row holds, stays a link change.
 */
export class TransactionDraft {
  private readonly rows = new Map<string, RowWrite>();
  private readonly joins: (ChangeOf<"link"> | ChangeOf<"unlink">)[] = [];

  create(entity: string, id: string, values: ColumnValues): void {
    Object.assign(this.row(entity, id, true).values, values);
  }

  update(entity: string, id: string, values: ColumnValues): void {
    Object.assign(this.row(entity, id, false).values, values);
  }

  /** `field` of the row now also points at `added` and no longer at `removed`. */
  relink(entity: string, id: string, field: string, added: readonly string[], removed: readonly string[]): void {
    const links = this.linksOf(entity);
    if (links.columnOf(field) !== null) {
      const target = added[added.length - 1];
      if (target !== undefined) this.hold(entity, id, field, target);
      else if (removed.length > 0) this.hold(entity, id, field, null);
      return;
    }
    const holder = links.holderOf(field);
    if (holder) {
      for (const targetId of removed) this.hold(holder.entity, targetId, holder.field, null);
      for (const targetId of added) this.hold(holder.entity, targetId, holder.field, id);
      return;
    }
    if (!links.isManyToMany(field)) return;
    if (added.length > 0) this.joins.push({ kind: "link", entity, id, field, targetIds: [...added] });
    if (removed.length > 0) this.joins.push({ kind: "unlink", entity, id, field, targetIds: [...removed] });
  }

  /**
   * New rows come first, each after the new rows it links to: the server
   * inserts them in the order listed, and a foreign key or an access policy
   * that looks the linked row up needs it to exist already. A link that
   * would close a cycle among new rows is left out of its create and set by
   * an update, which the server applies after every create.
   */
  build(id?: string): Transaction {
    const transaction = new Transaction(id);
    const deferred: { row: RowWrite; links: Record<string, string> }[] = [];
    const state = new Map<string, "visiting" | "done">();
    const insert = (row: RowWrite): void => {
      const key = keyOf(row.entity, row.id);
      if (state.get(key) === "done") return;
      state.set(key, "visiting");
      const links: Record<string, string | null> = {};
      const cut: Record<string, string> = {};
      for (const [field, target] of row.links) {
        const targetRow = target === null ? undefined : this.newRow(this.linksOf(row.entity).targetOf(field), target);
        if (target !== null && targetRow && state.get(keyOf(targetRow.entity, targetRow.id)) === "visiting") {
          cut[field] = target;
          continue;
        }
        if (targetRow) insert(targetRow);
        links[field] = target;
      }
      state.set(key, "done");
      transaction.create(row.entity, row.id, row.values, links);
      if (Object.keys(cut).length > 0) deferred.push({ row, links: cut });
    };
    for (const row of this.rows.values()) if (row.isNew) insert(row);
    for (const row of this.rows.values()) {
      if (row.isNew || (Object.keys(row.values).length === 0 && row.links.size === 0)) continue;
      transaction.update(row.entity, row.id, row.values, Object.fromEntries(row.links));
    }
    for (const { row, links } of deferred) transaction.update(row.entity, row.id, {}, links);
    for (const change of this.joins) {
      if (change.kind === "link") transaction.link(change.entity, change.id, change.field, change.targetIds);
      else transaction.unlink(change.entity, change.id, change.field, change.targetIds);
    }
    return transaction;
  }

  // Taken off one row and given to another in the same transaction, the
  // link ends up where it was given, whichever side was written first.
  private hold(entity: string, id: string, field: string, target: string | null): void {
    const links = this.row(entity, id, false).links;
    if (target === null && links.get(field) !== undefined && links.get(field) !== null) return;
    links.set(field, target);
  }

  private linksOf(entity: string): ModelLinks {
    return getEntityLinkStorage(entity);
  }

  private newRow(entity: string | undefined, id: string): RowWrite | undefined {
    const row = entity === undefined ? undefined : this.rows.get(keyOf(entity, id));
    return row?.isNew ? row : undefined;
  }

  private row(entity: string, id: string, isNew: boolean): RowWrite {
    const key = keyOf(entity, id);
    let row = this.rows.get(key);
    if (!row) {
      row = { entity, id, isNew, values: {}, links: new Map() };
      this.rows.set(key, row);
    } else if (isNew && !row.isNew) {
      row = { ...row, isNew: true };
      this.rows.set(key, row);
    }
    return row;
  }
}
