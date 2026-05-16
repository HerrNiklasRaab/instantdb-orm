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

export interface RootStoreConfig {
  db: InstantDBClient;
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

export type ModelConstructor<T extends Model = Model> = new (id: string) => T;

// Generic type helpers
export type ModelInstanceFor<_K extends string> = Model;
export type ModelClassFor<_K extends string> = ModelConstructor<Model>;
