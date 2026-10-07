import type { Model } from "../Model";
import type { SubscriptionObserver } from "../../subscriptions/SubscriptionObserver";
import type { SchemaDef } from "@zenstackhq/schema";
import type { SyncClient } from "../../client";
import type { Row } from "../../queries";
import type { TransactionOutcome } from "../../transactions";

export type RawEntityData = Row;

export interface RootStoreConfig<Schema extends SchemaDef> {
  client: SyncClient<Schema>;
  /**
   * Maintain a plain-JS `debugView` snapshot on every Model instance,
   * auto-updated via a MobX reaction. Workaround for debuggers that don't
   * display MobX observables (e.g. bun: https://github.com/oven-sh/bun/issues/25517).
   *
   * Off by default — the reaction adds an O(fields-per-model) snapshot
   * rebuild on every observable mutation plus a persistent copy of the
   * model's data. Enable only when you actually need debugger inspection.
   */
  debugView?: boolean;
  /**
   * Where subscription health is reported. Defaults to the console, which is
   * where it went for as long as nobody was listening.
   */
  subscriptionObserver?: SubscriptionObserver;
  /**
   * Told when the server denies one of this client's transactions, however
   * late the verdict arrives. By then the transaction has been undone
   * locally; the outcome carries the server's reason. Without a listener the
   * client logs a console warning.
   */
  onTransactionDenied?: (outcome: TransactionOutcome) => void;
}

export type Constructor<T = unknown> = { prototype: T; readonly name: string };

export type ModelConstructor<T extends Model = Model> = Constructor<T>;

type WithKey<K extends string, T> = K extends string ? T : T;
export type ModelInstanceFor<K extends string> = WithKey<K, Model>;
export type ModelClassFor<K extends string> = WithKey<K, ModelConstructor>;
