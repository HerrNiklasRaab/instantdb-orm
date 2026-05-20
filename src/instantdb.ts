import type {
  EntitiesDef,
  InstaQLParams,
  InstaQLResponse,
  InstantSchemaDef,
  LinksDef,
  RoomsDef,
  TransactionChunk,
  TxChunk,
  ValidQuery,
} from "@instantdb/core";

export type AnySchema = InstantSchemaDef<EntitiesDef, LinksDef<EntitiesDef>, RoomsDef>;

export type Unsubscribe = () => void;

export type QuerySubscriptionState<Schema extends AnySchema, Q> =
  | { error: { message: string; traceId?: string }; data: undefined }
  | { error: undefined; data: InstaQLResponse<Schema, Q> };

export abstract class InstantDBClient<Schema extends AnySchema> {
  abstract query<Q extends ValidQuery<Q, Schema>>(
    query: Q,
  ): Promise<InstaQLResponse<Schema, Q>>;

  abstract subscribeQuery<Q extends ValidQuery<Q, Schema>>(
    query: Q,
    callback: (state: QuerySubscriptionState<Schema, Q>) => void,
  ): Unsubscribe;

  abstract transact(
    chunks: TransactionChunk<Schema, keyof Schema["entities"] & string>[],
  ): Promise<void>;

  abstract readonly tx: TxChunk<Schema>;

  unsafeQuery<Q extends InstaQLParams<Schema>>(
    query: Q,
  ): Promise<InstaQLResponse<Schema, Q>> {
    type LooseQuery = (q: Q) => Promise<InstaQLResponse<Schema, Q>>;
    const call = this.query.bind(this) as unknown as LooseQuery;
    return call(query);
  }

  unsafeSubscribeQuery<Q extends InstaQLParams<Schema>>(
    query: Q,
    callback: (state: QuerySubscriptionState<Schema, Q>) => void,
  ): Unsubscribe {
    type LooseSubscribe = (
      q: Q,
      cb: (state: QuerySubscriptionState<Schema, Q>) => void,
    ) => Unsubscribe;
    const call = this.subscribeQuery.bind(this) as unknown as LooseSubscribe;
    return call(query, callback);
  }
}
