import type { ZenStackModels } from "../schema/DatabaseClient";
import { isRecord } from "../queries";
import { toRecords, UntypedClient } from "../storage/UntypedClient";
import type { KeyValue } from "./BucketKey";
import type { ParameterQuery } from "./BucketRule";

function isKeyValue(value: unknown): value is KeyValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Runs parameter queries against the database, unrestricted: whose rows say which keys an identity holds. */
export class ParameterQueries {
  private readonly db: UntypedClient;

  constructor(unrestricted: ZenStackModels) {
    this.db = new UntypedClient(unrestricted);
  }

  async values(query: ParameterQuery, identityId: string): Promise<KeyValue[]> {
    const rows = await this.db.model(query.model).findMany({
      where: { [query.identityColumn]: identityId },
      select: { [query.keyColumn]: true },
    });
    const values: KeyValue[] = [];
    for (const row of toRecords(rows)) {
      const value: unknown = isRecord(row) ? row[query.keyColumn] : undefined;
      if (isKeyValue(value)) values.push(value);
    }
    return values;
  }
}
