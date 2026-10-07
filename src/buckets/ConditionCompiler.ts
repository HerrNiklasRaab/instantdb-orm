import { QueryUtils, SchemaUtils } from "@zenstackhq/orm";
import type { BinaryExpression, CallExpression, Expression, SchemaDef } from "@zenstackhq/schema";
import {
  ColumnBucket,
  ColumnKey,
  GlobalBucket,
  ParameterQuery,
  RelationBucket,
  TupleBucket,
  type BucketRule,
} from "./BucketRule";
import { PolicyText } from "./PolicyText";
import { Collection, HopColumn, OwnColumn, RowReferences } from "./RowReference";

class RelationKey {
  constructor(
    readonly column: string,
    readonly parameter: ParameterQuery,
  ) {}
}

/** A term that narrows who holds the row: it becomes (part of) the bucket key. */
class Keyed {
  constructor(readonly key: ColumnKey | RelationKey) {}
}

/** A term that only narrows which rows match: dropped, the pull applies it. */
class Filter {
  constructor(readonly dropped: Expression) {}
}

/** A term the compiler cannot turn into a key; the whole rule falls back to global. */
class Unsupported {
  constructor(readonly reason: string) {}
}

type Term = Keyed | Filter | Unsupported;

function isAuthCall(expression: Expression): boolean {
  return expression.kind === "call" && expression.function === "auth";
}

/** `auth()` → `id`, `auth().team.id` → `team.id`, anything else → undefined. */
function authField(expression: Expression): string | undefined {
  if (isAuthCall(expression)) return "id";
  if (expression.kind === "member" && isAuthCall(expression.receiver)) return expression.members.join(".");
  return undefined;
}

function mentionsAuth(expression: Expression): boolean {
  return new SchemaUtils.MatchingExpressionVisitor(isAuthCall).find(expression);
}

/** The operands of a chain of `op`, in source order. */
function operands(expression: Expression, op: "&&" | "||"): Expression[] {
  if (expression.kind === "binary" && expression.op === op) {
    return [...operands(expression.left, op), ...operands(expression.right, op)];
  }
  return [expression];
}

/** Compiles one model's read conditions into bucket rules. */
export class ConditionCompiler {
  private readonly rows: RowReferences;

  constructor(
    private readonly schema: SchemaDef,
    private readonly model: string,
  ) {
    this.rows = new RowReferences(schema, model);
  }

  /** Every read rule of the model, as one union; a single global rule when any part cannot be keyed. */
  compileModel(): BucketRule[] {
    const rules = this.readConditions().flatMap((condition) => this.compile(condition));
    const global = rules.find((rule) => rule.kind === "global" && rule.reason !== null)
      ?? rules.find((rule) => rule.kind === "global");
    return global ? [global] : rules;
  }

  compile(condition: Expression): BucketRule[] {
    return operands(condition, "||").map((branch) => this.branch(branch));
  }

  private readConditions(): Expression[] {
    const conditions: Expression[] = [];
    for (const attribute of QueryUtils.requireModel(this.schema, this.model).attributes ?? []) {
      if (attribute.name !== "@@allow") continue;
      const operation = attribute.args?.find((arg) => arg.name === "operation")?.value;
      const condition = attribute.args?.find((arg) => arg.name === "condition")?.value;
      if (condition && this.isReadOperation(operation)) conditions.push(condition);
    }
    return conditions;
  }

  private isReadOperation(expression: Expression | undefined): boolean {
    if (expression?.kind !== "literal" || typeof expression.value !== "string") return false;
    const operations = expression.value.split(",").map((operation) => operation.trim());
    return operations.includes("read") || operations.includes("all");
  }

  private branch(expression: Expression): BucketRule {
    const terms = operands(expression, "&&").map((term) => this.term(term));
    const unsupported = terms.find((term) => term instanceof Unsupported);
    if (unsupported instanceof Unsupported) return new GlobalBucket(unsupported.reason);
    const keys = terms.filter((term) => term instanceof Keyed).map((term) => term.key);
    const relation = keys.find((key) => key instanceof RelationKey);
    if (relation instanceof RelationKey) return new RelationBucket(relation.column, relation.parameter);
    const columns = keys.filter((key) => key instanceof ColumnKey);
    const [single] = columns;
    if (columns.length === 0) return new GlobalBucket(null);
    if (columns.length === 1 && single) return new ColumnBucket(single);
    return new TupleBucket(columns);
  }

  private term(expression: Expression): Term {
    switch (expression.kind) {
      case "binary":
        return this.binary(expression);
      case "call":
        return expression.function === "check" ? this.check(expression) : this.filterUnlessAuth(expression);
      case "unary":
        return new Unsupported(PolicyText.of(expression));
      default:
        return this.filterUnlessAuth(expression);
    }
  }

  private binary(expression: BinaryExpression): Term {
    switch (expression.op) {
      case "==":
        return this.equality(expression);
      case "?":
        return this.some(expression);
      case "!":
      case "^":
        return new Unsupported(PolicyText.of(expression));
      case "!=":
        return this.isNullCheck(expression) ? new Filter(expression) : this.filterUnlessAuth(expression);
      default:
        return this.filterUnlessAuth(expression);
    }
  }

  /** `auth() == null` / `auth() != null`: who is signed in, not which rows; the pull enforces it. */
  private isNullCheck(expression: Expression): boolean {
    if (expression.kind !== "binary") return false;
    return (isAuthCall(expression.left) && expression.right.kind === "null")
      || (isAuthCall(expression.right) && expression.left.kind === "null");
  }

  private filterUnlessAuth(expression: Expression): Term {
    if (this.isNullCheck(expression) || !mentionsAuth(expression)) return new Filter(expression);
    return new Unsupported(PolicyText.of(expression));
  }

  private equality(expression: BinaryExpression): Term {
    if (this.isNullCheck(expression)) return new Filter(expression);
    const [authSide, rowSide] = authField(expression.left) !== undefined
      ? [expression.left, expression.right]
      : [expression.right, expression.left];
    const field = authField(authSide);
    if (field === undefined) return this.filterUnlessAuth(expression);
    const reference = this.rows.resolve(rowSide);
    if (reference instanceof OwnColumn) return new Keyed(new ColumnKey(reference.column, field));
    if (reference instanceof HopColumn && field === "id") {
      const parameter = new ParameterQuery(reference.target, reference.column, RowReferences.idColumnOf(this.schema, reference.target));
      return new Keyed(new RelationKey(reference.foreignKey, parameter));
    }
    return new Unsupported(PolicyText.of(expression));
  }

  /** `members?[userId == auth().id]`: the row is held by whoever has a member row pointing back at it. */
  private some(expression: BinaryExpression): Term {
    const collection = this.rows.resolve(expression.left);
    if (!(collection instanceof Collection)) return new Unsupported(PolicyText.of(expression));
    const identity = this.identityColumn(expression.right, collection.target);
    if (identity === undefined) return new Unsupported(PolicyText.of(expression));
    const parameter = new ParameterQuery(collection.target, identity, collection.backColumn);
    return new Keyed(new RelationKey(collection.keyColumn, parameter));
  }

  /** Inside a predicate on `target`: the one column compared with `auth().id`; other terms must be row-only. */
  private identityColumn(predicate: Expression, target: string): string | undefined {
    let identity: string | undefined;
    for (const term of operands(predicate, "&&")) {
      if (!mentionsAuth(term)) continue;
      if (term.kind !== "binary" || term.op !== "==") return undefined;
      const [authSide, columnSide] = authField(term.left) !== undefined ? [term.left, term.right] : [term.right, term.left];
      if (authField(authSide) !== "id" || columnSide.kind !== "field" || identity !== undefined) return undefined;
      if (QueryUtils.getField(this.schema, target, columnSide.field)?.relation) return undefined;
      identity = columnSide.field;
    }
    return identity;
  }

  /** `check(team)`: the related model's read rules, seen from this row over the relation's foreign key. */
  private check(expression: CallExpression): Term {
    const [argument] = expression.args ?? [];
    const relation = argument?.kind === "field" ? this.rows.resolve(argument) : undefined;
    if (!(relation instanceof OwnColumn) || argument?.kind !== "field") return new Unsupported(PolicyText.of(expression));
    const target = QueryUtils.requireField(this.schema, this.model, argument.field).type;
    const [rule, ...rest] = new ConditionCompiler(this.schema, target).compileModel();
    if (!rule || rest.length > 0) return new Unsupported(PolicyText.of(expression));
    const targetId = RowReferences.idColumnOf(this.schema, target);
    switch (rule.kind) {
      case "column":
        return new Keyed(new RelationKey(relation.column, new ParameterQuery(target, rule.column, targetId)));
      case "relation":
        return rule.column === targetId
          ? new Keyed(new RelationKey(relation.column, rule.parameter))
          : new Unsupported(PolicyText.of(expression));
      case "global":
        return rule.reason === null ? new Filter(expression) : new Unsupported(rule.reason);
      case "tuple":
        return new Unsupported(PolicyText.of(expression));
    }
  }
}
