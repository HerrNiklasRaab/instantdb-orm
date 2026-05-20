import type { AnySchema } from "@upfor/shared";
import type { Model } from "../Model";
import type { InstantDBClient } from "../persistence/types";

export interface RawEntityData {
  id: string;
  [key: string]: unknown;
}

export type QueryResult = {
  [entityName: string]: RawEntityData[] | undefined;
};

export type { InstantDBClient };

export interface RootStoreConfig<Schema extends AnySchema> {
  db: InstantDBClient<Schema>;
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
}

export type ModelConstructor<T extends Model = Model> = { prototype: T; readonly name: string };

type WithKey<K extends string, T> = K extends string ? T : T;
export type ModelInstanceFor<K extends string> = WithKey<K, Model>;
export type ModelClassFor<K extends string> = WithKey<K, ModelConstructor>;
