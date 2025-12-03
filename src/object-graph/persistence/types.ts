export interface TxChunk {
  update(data: Record<string, unknown>): TxChunk;
  link(links: Record<string, string | string[]>): TxChunk;
  unlink(links: Record<string, string | string[]>): TxChunk;
  delete(): TxChunk;
  merge(data: Record<string, unknown>): TxChunk;
  ruleParams(params: Record<string, unknown>): TxChunk;
}

type TxProxy = {
  [entityName: string]: {
    [id: string]: TxChunk;
  };
};

export interface TransactionResult {
  status: "enqueued" | "synced";
  clientId: string;
  "tx-id"?: string;
}

export interface QueryOptions {
  timeout?: number;
}

export type SubscriptionCallback<T = unknown> = (result: {
  error?: { message: string };
  data?: T;
}) => void;
export type Unsubscribe = () => void;

export interface InstantDBClient {
  query<T = unknown>(
    query: Record<string, unknown>,
    opts?: QueryOptions
  ): Promise<T>;
  transact(chunks: TxChunk | TxChunk[]): Promise<TransactionResult>;
  subscribeQuery<T = unknown>(
    query: Record<string, unknown>,
    callback: SubscriptionCallback<T>,
    opts?: QueryOptions
  ): Unsubscribe;
  tx: TxProxy;
}
