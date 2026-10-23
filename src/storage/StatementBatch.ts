// The wire protocol counts a statement's bind parameters in an Int16, and
// PGlite reads it signed: 32768 and up fail with "Invalid array length".
const MAX_BIND_PARAMETERS = 32_767;

/** Splits rows across statements so no statement binds more parameters than the database accepts. */
export class StatementBatch {
  private constructor(private readonly rowsPerStatement: number) {}

  static forColumns(count: number): StatementBatch {
    if (!Number.isInteger(count) || count < 1 || count > MAX_BIND_PARAMETERS) throw new Error(`A row cannot bind ${count} parameters.`);
    return new StatementBatch(Math.floor(MAX_BIND_PARAMETERS / count));
  }

  split<T>(rows: readonly T[]): T[][] {
    const batches: T[][] = [];
    for (let start = 0; start < rows.length; start += this.rowsPerStatement) {
      batches.push(rows.slice(start, start + this.rowsPerStatement));
    }
    return batches;
  }
}
