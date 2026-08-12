import type { InstantAdminDatabase } from "@instantdb/admin";
import type {
  InstaQLResponse,
  TransactionChunk,
  TxChunk,
  ValidQuery,
} from "@instantdb/core";
import {
  InstantDBClient,
  type AnySchema,
  type QuerySubscriptionState,
  type Unsubscribe,
} from "../instantdb";

type AdminDB<Schema extends AnySchema> = InstantAdminDatabase<Schema>;

function attachCaller(err: unknown, caller: string | undefined): unknown {
  if (err !== null && typeof err === "object" && caller !== undefined) {
    const existingStack: unknown = Reflect.get(err, "stack");
    const prefix = typeof existingStack === "string" ? existingStack : "";
    Reflect.set(err, "stack", `${prefix}\n--- caller ---\n${caller}`);
  }
  return err;
}

export class InstantDBAdminAdapter<Schema extends AnySchema> extends InstantDBClient<Schema> {
  private readonly client: AdminDB<Schema>;
  readonly tx: TxChunk<Schema>;

  constructor(client: AdminDB<Schema>) {
    super();
    this.client = client;
    this.tx = client.tx;
  }

  async query<Q extends ValidQuery<Q, Schema>>(
    query: Q,
  ): Promise<InstaQLResponse<Schema, Q>> {
    const caller = new Error().stack;
    try {
      return await this.client.query<Q>(query);
    } catch (err: unknown) {
      throw attachCaller(err, caller);
    }
  }

  async transact(
    chunks: TransactionChunk<Schema, keyof Schema["entities"] & string>[],
  ): Promise<void> {
    const caller = new Error().stack;
    try {
      await this.client.transact(chunks);
    } catch (err: unknown) {
      throw attachCaller(err, caller);
    }
  }

  subscribeQuery<Q extends ValidQuery<Q, Schema>>(
    query: Q,
    callback: (state: QuerySubscriptionState<Schema, Q>) => void,
  ): Unsubscribe {
    const subscription = this.client.subscribeQuery<Q>(query, (payload) => {
      if (payload.type === "error") {
        // `isClosed` is the whole signal: the EventSource behind this stream
        // gives up permanently on a non-200 reconnect, and nothing re-opens it
        // unless the caller does. Flattening it to a message once cost us a
        // day and a half of deaf reactors.
        callback({
          error: {
            message: payload.error.message,
            status: payload.error.status,
            isClosed: payload.isClosed,
            ...(payload.error.traceId === undefined ? {} : { traceId: payload.error.traceId }),
          },
          data: undefined,
        });
      } else {
        callback({
          error: undefined,
          data: payload.data,
        });
      }
    });
    return () => { subscription.close(); };
  }
}
