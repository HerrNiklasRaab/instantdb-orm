import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A deployment's migration folder: one `<NNNN_name>/migration.sql` per step, applied in name order. */
export class Migrations {
  constructor(private readonly dir: string) {}

  scripts(): string[] {
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .map((name) => readFileSync(join(this.dir, name, "migration.sql"), "utf8"));
  }
}
