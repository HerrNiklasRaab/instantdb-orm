import { Lsn } from "./Lsn";

/** A tuple as `pgoutput` sends it: column name to text value, `null` for SQL NULL. Unchanged TOAST columns are absent. */
export type TextTuple = Readonly<Record<string, string | null>>;

/** One row written by a committed transaction, old and new as the WAL carries them. */
export class RowChange {
  constructor(
    readonly table: string,
    readonly before: TextTuple | null,
    readonly after: TextTuple | null,
  ) {}
}

/** Everything one database transaction wrote, in the order it wrote it. */
export class WalTransaction {
  constructor(
    /** Where the commit lies in the WAL; the slot is advanced to it once the transaction is filed. */
    readonly commitLsn: Lsn,
    readonly changes: readonly RowChange[],
  ) {}
}

interface Relation {
  readonly table: string;
  readonly columns: readonly string[];
}

/** Reads one `pgoutput` message (protocol version 1). */
class MessageReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  byte(): number {
    return this.view.getUint8(this.offset++);
  }

  int16(): number {
    const value = this.view.getInt16(this.offset);
    this.offset += 2;
    return value;
  }

  int32(): number {
    const value = this.view.getInt32(this.offset);
    this.offset += 4;
    return value;
  }

  lsn(): Lsn {
    const high = this.view.getUint32(this.offset);
    const low = this.view.getUint32(this.offset + 4);
    this.offset += 8;
    return Lsn.parse(`${high.toString(16)}/${low.toString(16)}`);
  }

  skip(length: number): void {
    this.offset += length;
  }

  string(): string {
    const end = this.bytes.indexOf(0, this.offset);
    const text = new TextDecoder().decode(this.bytes.subarray(this.offset, end));
    this.offset = end + 1;
    return text;
  }

  text(length: number): string {
    const text = new TextDecoder().decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return text;
  }
}

/**
 * Turns the binary messages of a logical replication slot read with
 * `pgoutput` into whole committed transactions. Relation messages precede
 * the first change to each table in every read, so one decoder serves one
 * read of the slot.
 */
export class PgOutputDecoder {
  private readonly relations = new Map<number, Relation>();
  private open: RowChange[] | null = null;

  decode(messages: readonly Uint8Array[]): WalTransaction[] {
    const transactions: WalTransaction[] = [];
    for (const message of messages) {
      const committed = this.read(new MessageReader(message));
      if (committed) transactions.push(committed);
    }
    return transactions;
  }

  private read(reader: MessageReader): WalTransaction | null {
    const kind = String.fromCharCode(reader.byte());
    switch (kind) {
      case "B":
        this.open = [];
        return null;
      case "C": {
        reader.skip(1);
        reader.lsn();
        const end = reader.lsn();
        const changes = this.open ?? [];
        this.open = null;
        return new WalTransaction(end, changes);
      }
      case "R":
        this.readRelation(reader);
        return null;
      case "I": {
        const relation = this.relation(reader.int32());
        reader.skip(1);
        this.record(new RowChange(relation.table, null, this.readTuple(reader, relation)));
        return null;
      }
      case "U": {
        const relation = this.relation(reader.int32());
        const tag = String.fromCharCode(reader.byte());
        let before: TextTuple | null = null;
        if (tag === "O" || tag === "K") {
          before = this.readTuple(reader, relation);
          reader.skip(1);
        }
        const after = this.readTuple(reader, relation);
        this.record(new RowChange(relation.table, before, before ? { ...before, ...after } : after));
        return null;
      }
      case "D": {
        const relation = this.relation(reader.int32());
        reader.skip(1);
        this.record(new RowChange(relation.table, this.readTuple(reader, relation), null));
        return null;
      }
      default:
        // Truncate, type, origin and logical messages say nothing about rows clients hold.
        return null;
    }
  }

  private readRelation(reader: MessageReader): void {
    const id = reader.int32();
    reader.string();
    const table = reader.string();
    reader.skip(1);
    const count = reader.int16();
    const columns: string[] = [];
    for (let index = 0; index < count; index++) {
      reader.skip(1);
      columns.push(reader.string());
      reader.skip(8);
    }
    this.relations.set(id, { table, columns });
  }

  private readTuple(reader: MessageReader, relation: Relation): TextTuple {
    const tuple: Record<string, string | null> = {};
    const count = reader.int16();
    for (let index = 0; index < count; index++) {
      const column = relation.columns[index] ?? `column${index}`;
      const kind = String.fromCharCode(reader.byte());
      if (kind === "n") tuple[column] = null;
      else if (kind === "t") tuple[column] = reader.text(reader.int32());
      else if (kind === "b") throw new Error(`Column ${relation.table}.${column} arrived in binary; the slot must be read with text tuples.`);
    }
    return tuple;
  }

  private relation(id: number): Relation {
    const relation = this.relations.get(id);
    if (!relation) throw new Error(`pgoutput sent a change for relation ${id} before describing it.`);
    return relation;
  }

  private record(change: RowChange): void {
    if (!this.open) throw new Error("pgoutput sent a change outside a transaction.");
    this.open.push(change);
  }
}
