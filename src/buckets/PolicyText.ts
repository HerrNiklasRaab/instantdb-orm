import type { Expression } from "@zenstackhq/schema";

/** ZModel-like text of a policy expression, for diagnostics. */
export class PolicyText {
  static of(expression: Expression): string {
    return new PolicyText().render(expression);
  }

  private render(expression: Expression): string {
    switch (expression.kind) {
      case "literal":
        return typeof expression.value === "string" ? `'${expression.value}'` : String(expression.value);
      case "array":
        return `[${expression.items.map((item) => this.render(item)).join(", ")}]`;
      case "field":
        return expression.field;
      case "member":
        return [this.render(expression.receiver), ...expression.members].join(".");
      case "binding":
        return expression.name;
      case "call":
        return `${expression.function}(${(expression.args ?? []).map((arg) => this.render(arg)).join(", ")})`;
      case "this":
        return "this";
      case "null":
        return "null";
      case "unary":
        return `${expression.op}(${this.render(expression.operand)})`;
      case "binary":
        return this.isQuantifier(expression.op)
          ? `${this.render(expression.left)}${expression.op}[${this.render(expression.right)}]`
          : `${this.render(expression.left)} ${expression.op} ${this.render(expression.right)}`;
    }
  }

  private isQuantifier(op: string): boolean {
    return op === "?" || op === "!" || op === "^";
  }
}
