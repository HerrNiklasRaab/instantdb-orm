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

const IDENTITY_CHANGED_ERROR_TYPE = "user-changed";

// InstantDB clears its whole pending-mutation queue the moment the client's
// auth identity changes, rejecting every unconfirmed write with this body
// type. Nothing can recover such a write: the identity that was permitted to
// author it no longer exists on this client.
export function writeDroppedByIdentityChange(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const body: unknown = Reflect.get(error, "body");
  if (typeof body !== "object" || body === null) return false;
  return Reflect.get(body, "type") === IDENTITY_CHANGED_ERROR_TYPE;
}

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
