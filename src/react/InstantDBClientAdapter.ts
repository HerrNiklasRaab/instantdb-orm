import type { InstantReactWebDatabase } from "@instantdb/react";
import type {
  InstaQLResponse,
  ValidQuery,
  TransactionChunk,
  TxChunk,
} from "@instantdb/core";
import {
  InstantDBClient,
  type AnySchema,
  type QuerySubscriptionState,
  type Unsubscribe,
} from "../instantdb";

export class InstantDBClientAdapter<Schema extends AnySchema>
  extends InstantDBClient<Schema>
{
  private client: InstantReactWebDatabase<Schema>;

  constructor(client: InstantReactWebDatabase<Schema>) {
    super();
    this.client = client;
  }

  async query<Q extends ValidQuery<Q, Schema>>(
    query: Q,
  ): Promise<InstaQLResponse<Schema, Q>> {
    const result = await this.client.queryOnce(query);
    return result.data;
  }

  async transact(
    chunks: TransactionChunk<Schema, keyof Schema["entities"] & string>[],
  ): Promise<void> {
    await this.client.transact(chunks);
  }

  subscribeQuery<Q extends ValidQuery<Q, Schema>>(
    query: Q,
    callback: (state: QuerySubscriptionState<Schema, Q>) => void,
  ): Unsubscribe {
    return this.client.core.subscribeQuery(query, (state) => {
      if (state.error) {
        callback({ error: state.error, data: undefined });
      } else {
        callback({ error: undefined, data: state.data });
      }
    });
  }

  get tx(): TxChunk<Schema> {
    return this.client.tx;
  }
}
