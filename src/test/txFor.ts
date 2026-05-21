import type { TransactionChunk, TxChunk } from "@instantdb/core";
import type { AnySchema } from "../instantdb";

export function txFor<
  Schema extends AnySchema,
  EntityName extends keyof Schema["entities"] & string,
>(
  tx: TxChunk<Schema>,
  entity: EntityName,
  rowId: string,
): TransactionChunk<Schema, EntityName> {
  const rowTx = tx[entity][rowId];
  if (!rowTx) {
    throw new Error(`txFor: no transaction chunk for ${entity}[${rowId}]`);
  }
  return rowTx;
}
