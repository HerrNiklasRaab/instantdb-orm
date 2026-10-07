import { SqlJsDialect } from "@zenstackhq/orm/dialects/sql.js";
import initSqlJs from "sql.js";

const sqlJs = await initSqlJs();

/** A fresh, empty SQLite database (WASM) living in this process. */
export function inMemorySqliteDialect(): SqlJsDialect {
  return new SqlJsDialect({ sqlJs: new sqlJs.Database() });
}
