import { QueryUtils } from "@zenstackhq/orm";
import type { Expression, SchemaDef } from "@zenstackhq/schema";

/** A scalar column of the row itself, or the foreign key of one of its to-one relations. */
export class OwnColumn {
  constructor(readonly column: string) {}
}

/** One to-one hop away: `room.hostId` is the column `column` on `target`, reached over the row's `foreignKey`. */
export class HopColumn {
  constructor(
    readonly foreignKey: string,
    readonly target: string,
    readonly column: string,
  ) {}
}

/** A to-many relation, on the row or one to-one hop away, whose rows point back at `keyColumn` of the row. */
export class Collection {
  constructor(
    /** The row's column the collection is keyed by: its id, or the foreign key of the hop. */
    readonly keyColumn: string,
    readonly target: string,
    /** The target's foreign key back to what the collection hangs off. */
    readonly backColumn: string,
  ) {}
}

export type RowReference = OwnColumn | HopColumn | Collection;

/** Resolves the row side of a policy expression against the model's relations. */
export class RowReferences {
  constructor(
    private readonly schema: SchemaDef,
    private readonly model: string,
  ) {}

  resolve(expression: Expression): RowReference | undefined {
    if (expression.kind === "field") return this.resolveField(expression.field);
    if (expression.kind !== "member") return undefined;
    if (expression.receiver.kind === "this") {
      const [field, ...rest] = expression.members;
      return field !== undefined && rest.length === 0 ? this.resolveField(field) : undefined;
    }
    if (expression.receiver.kind !== "field") return undefined;
    const [member, ...rest] = expression.members;
    if (member === undefined || rest.length > 0) return undefined;
    return this.resolveHop(expression.receiver.field, member);
  }

  idColumn(): string {
    return RowReferences.idColumnOf(this.schema, this.model);
  }

  static idColumnOf(schema: SchemaDef, model: string): string {
    const [id] = QueryUtils.requireIdFields(schema, model);
    if (id === undefined) throw new Error(`Model ${model} has no id field`);
    return id;
  }

  private resolveField(name: string): RowReference | undefined {
    const field = QueryUtils.getField(this.schema, this.model, name);
    if (!field) return undefined;
    if (!field.relation) return new OwnColumn(name);
    if (field.array) return new Collection(this.idColumn(), field.type, this.foreignKey(this.model, name));
    return new OwnColumn(this.foreignKey(this.model, name));
  }

  private resolveHop(relation: string, member: string): RowReference | undefined {
    const first = QueryUtils.getField(this.schema, this.model, relation);
    if (!first?.relation || first.array) return undefined;
    const foreignKey = this.foreignKey(this.model, relation);
    const second = QueryUtils.getField(this.schema, first.type, member);
    if (!second) return undefined;
    if (!second.relation) return new HopColumn(foreignKey, first.type, member);
    if (second.array) return new Collection(foreignKey, second.type, this.foreignKey(first.type, member));
    return undefined;
  }

  private foreignKey(model: string, relation: string): string {
    const [pair] = QueryUtils.getRelationForeignKeyFieldPairs(this.schema, model, relation).keyPairs;
    if (!pair) throw new Error(`Relation ${model}.${relation} has no foreign key`);
    return pair.fk;
  }
}
