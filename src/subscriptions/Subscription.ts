import type { QueryResult } from "../queries/SyncQuery";

export type Unsubscribe = () => void;

/**
 * `isClosed` separates a blip from a funeral: a transport that gave up for
 * good cannot reconnect on its own, so only the caller can re-subscribe.
 * Left `undefined` by transports that supervise their own reconnects.
 */
export interface SubscriptionError {
  message: string;
  status?: number;
  isClosed?: boolean;
  traceId?: string;
}

export type QuerySubscriptionState =
  | { error: SubscriptionError; data: undefined }
  | { error: undefined; data: QueryResult };
