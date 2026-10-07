import type { ColumnValue } from "../object-graph/columns/types";
import type { ModelDef } from "@zenstackhq/schema";
import { v4 as uuid } from "uuid";
import { decodeChange, decodeJson } from "../protocol";
import type { QueryResult } from "../queries/SyncQuery";

export type ColumnValues = Readonly<Record<string, ColumnValue>>;

/** The to-one links a row holds, by relation field: the id it points at, or `null` for none. */
export type RowLinks = Readonly<Record<string, string | null>>;

/**
 * One row-level change: the unit a transaction is made of and the log
 * records. A row's own to-one links travel with its create or update, so the
 * row is written whole; `link`/`unlink` are many-to-many only.
 */
export type Change =
  | { readonly kind: "create"; readonly entity: string; readonly id: string; readonly values: ColumnValues; readonly links?: RowLinks | undefined }
  | { readonly kind: "update"; readonly entity: string; readonly id: string; readonly values: ColumnValues; readonly links?: RowLinks | undefined }
  | { readonly kind: "link"; readonly entity: string; readonly id: string; readonly field: string; readonly targetIds: readonly string[] }
  | { readonly kind: "unlink"; readonly entity: string; readonly id: string; readonly field: string; readonly targetIds: readonly string[] }
  | { readonly kind: "delete"; readonly entity: string; readonly id: string };

export type ChangeKind = Change["kind"];

export type ChangeOf<K extends ChangeKind> = Extract<Change, { kind: K }>;

/** `committed`: applied. `denied`: the server refused it and applied nothing. */
export type TransactionStatus = "committed" | "denied";

/**
 * What became of a transaction, as its author learns it. `pending` means the
 * server has not been reached yet: the transaction is applied locally and
 * will be sent when a connection exists.
 */
export interface TransactionOutcome {
  readonly transactionId: string;
  readonly tick: number | null;
  readonly status: TransactionStatus | "pending";
  readonly reason: string | null;
}

/**
 * What a logged transaction means for one identity: its outcome, and — when
 * it was committed — the touched rows in their state after the commit, as
 * that identity is allowed to see them, plus the ids of touched rows it
 * cannot (or can no longer) see. The same shape carries a denied transaction
 * being taken back: the server's rows, and what the server does not have.
 */
export interface TransactionEffect extends TransactionOutcome {
  readonly tick: number;
  readonly status: TransactionStatus;
  readonly rows: QueryResult;
  readonly removed: Record<string, string[]>;
}

/** A change as a row of the log's `changes` model. */
export interface ChangeLogRow {
  readonly kind: string;
  readonly entity: string;
  readonly entityId: string;
  readonly field: string | null;
  readonly values: unknown;
  readonly links: unknown;
  readonly targetIds: unknown;
}

/**
 * A set of changes that succeeds or fails as one. The id is chosen by the
 * author, so the same transaction is recognisable on the client, on the
 * wire, in the server's log and in what other clients receive.
 */
export class Transaction {
  private readonly entries: Change[];

  constructor(
    readonly id: string = uuid(),
    changes: readonly Change[] = [],
  ) {
    this.entries = [...changes];
  }

  /** Read back from the log's `changes` rows, validated on the way out. */
  static fromLogRows(id: string, rows: readonly ChangeLogRow[]): Transaction {
    return new Transaction(id, rows.map(({ kind, entity, entityId, field, values, links, targetIds }) => decodeChange({
      kind,
      entity,
      id: entityId,
      ...(values === null || values === undefined ? {} : { values }),
      ...(links === null || links === undefined ? {} : { links }),
      ...(field === null ? {} : { field }),
      ...(targetIds === null || targetIds === undefined ? {} : { targetIds }),
    })));
  }

  create(entity: string, id: string, values: ColumnValues, links: RowLinks = {}): this {
    this.entries.push({ kind: "create", entity, id, values, ...(Object.keys(links).length > 0 ? { links } : {}) });
    return this;
  }

  update(entity: string, id: string, values: ColumnValues, links: RowLinks = {}): this {
    this.entries.push({ kind: "update", entity, id, values, ...(Object.keys(links).length > 0 ? { links } : {}) });
    return this;
  }

  link(entity: string, id: string, field: string, targetIds: readonly string[]): this {
    if (targetIds.length > 0) this.entries.push({ kind: "link", entity, id, field, targetIds });
    return this;
  }

  unlink(entity: string, id: string, field: string, targetIds: readonly string[]): this {
    if (targetIds.length > 0) this.entries.push({ kind: "unlink", entity, id, field, targetIds });
    return this;
  }

  delete(entity: string, id: string): this {
    this.entries.push({ kind: "delete", entity, id });
    return this;
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  get changes(): readonly Change[] {
    return this.entries;
  }

  ofKind<K extends ChangeKind>(kind: K): ChangeOf<K>[] {
    return this.entries.filter((change): change is ChangeOf<K> => change.kind === kind);
  }

  /** Every row this transaction writes, including the rows it links them to. */
  touchedRows(models: Readonly<Record<string, ModelDef>>): Map<string, Set<string>> {
    const touched = new Map<string, Set<string>>();
    const touch = (entity: string, id: string): void => {
      const ids = touched.get(entity) ?? new Set<string>();
      touched.set(entity, ids);
      ids.add(id);
    };
    const targetOf = (entity: string, field: string): string | undefined => models[entity]?.fields[field]?.type;
    for (const change of this.entries) {
      touch(change.entity, change.id);
      if (change.kind === "link" || change.kind === "unlink") {
        const target = targetOf(change.entity, change.field);
        if (target !== undefined) for (const targetId of change.targetIds) touch(target, targetId);
      } else if ("links" in change && change.links) {
        for (const [field, targetId] of Object.entries(change.links)) {
          const target = targetOf(change.entity, field);
          if (target !== undefined && targetId !== null) touch(target, targetId);
        }
      }
    }
    return touched;
  }

  /** The changes as rows of the log's `changes` model, in order. */
  toLogRows() {
    return this.entries.map((change, position) => ({
      transactionId: this.id,
      position,
      kind: change.kind,
      entity: change.entity,
      entityId: change.id,
      ...("field" in change ? { field: change.field } : {}),
      ...("values" in change ? { values: decodeJson(change.values) } : {}),
      ...("links" in change && change.links ? { links: { ...change.links } } : {}),
      ...("targetIds" in change ? { targetIds: [...change.targetIds] } : {}),
    }));
  }

  outcome(status: TransactionOutcome["status"], tick: number | null = null, reason: string | null = null): TransactionOutcome {
    return { transactionId: this.id, tick, status, reason };
  }
}
