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
}

export type ModelConstructor<T extends Model = Model> = new (id: string) => T;
