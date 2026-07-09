import {
  id,
  init,
  StoreInterface,
  type InstaQLResponse,
  type InstantCoreDatabase,
  type StoreInterfaceStoreName,
  type TransactionChunk,
  type ValidQuery,
} from "@instantdb/core";
import {
  InstantDBClient,
  type AnySchema,
  type QuerySubscriptionState,
  type Unsubscribe,
} from "../instantdb";
import { configureEntityMeta } from "../object-graph";

type CoreInitConfig<Schema extends AnySchema> = Parameters<typeof init<Schema>>[0];
type InMemoryInstantDBConfig<Schema extends AnySchema> =
  Omit<CoreInitConfig<Schema>, "appId"> & { appId?: string };
type EntityName<Schema extends AnySchema> = keyof Schema["entities"] & string;
type SchemaChunk<Schema extends AnySchema> = TransactionChunk<Schema, EntityName<Schema>>;

export class InMemoryInstantDBSyncClient<Schema extends AnySchema>
  extends InstantDBClient<Schema> {
  private readonly db: InstantCoreDatabase<Schema>;

  constructor(config: InMemoryInstantDBConfig<Schema> = {}) {
    super();
    if (config.schema) configureEntityMeta(config.schema);
    this.db = InMemoryInstantDBSyncClient.createDb(config);
  }

  get tx(): InstantCoreDatabase<Schema>["tx"] {
    return this.db.tx;
  }

  async query<Q extends ValidQuery<Q, Schema>>(
    query: Q,
  ): Promise<InstaQLResponse<Schema, Q>> {
    const resultPromise = this.db.queryOnce(query);
    this.primeQuery(query);
    const result = await resultPromise;
    return result.data;
  }

  async transact(
    chunks: SchemaChunk<Schema>[],
  ): Promise<void> {
    await this.db.transact(chunks);
  }

  subscribeQuery<Q extends ValidQuery<Q, Schema>>(
    query: Q,
    callback: (state: QuerySubscriptionState<Schema, Q>) => void,
  ): Unsubscribe {
    const unsubscribe = this.db.subscribeQuery(query, (state) => {
      if (state.error) {
        callback({ error: state.error, data: undefined });
      } else {
        callback({ error: undefined, data: state.data });
      }
    });
    this.primeQuery(query);
    return unsubscribe;
  }

  private primeQuery<Q extends ValidQuery<Q, Schema>>(query: Q): void {
    this.db._reactor._setAttrs([]);
    this.db._reactor._addQueryData(query, { triples: [], pageInfo: undefined }, true);
  }

  private static createDb<Schema extends AnySchema>(
    config: InMemoryInstantDBConfig<Schema> = {},
  ): InstantCoreDatabase<Schema> {
    const appId = config.appId ?? id();
    const restoreBrowserGlobals = installBrowserGlobals();

    try {
      const db = withoutBroadcastChannel(() =>
        init<Schema>(
          {
            ...config,
            appId,
            devtool: false,
          },
          MapInstantStore,
          QuietNetworkListener,
        ),
      );
      return db;
    } finally {
      restoreBrowserGlobals();
    }
  }
}

class MapInstantStore extends StoreInterface {
  private static readonly stores = new Map<string, Map<string, unknown>>();
  private readonly store: Map<string, unknown>;

  constructor(appId: string, storeName: StoreInterfaceStoreName) {
    super(appId, storeName);
    const key = `${appId}:${storeName}`;
    let store = MapInstantStore.stores.get(key);
    if (!store) {
      store = new Map();
      MapInstantStore.stores.set(key, store);
    }
    this.store = store;
  }

  getItem(key: string): Promise<unknown> {
    return Promise.resolve(this.store.get(key));
  }

  removeItem(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  multiSet(keyValuePairs: Array<[string, unknown]>): Promise<void> {
    for (const [key, value] of keyValuePairs) {
      this.store.set(key, value);
    }
    return Promise.resolve();
  }

  getAllKeys(): Promise<string[]> {
    return Promise.resolve([...this.store.keys()]);
  }
}

const QuietNetworkListener = {
  getIsOnline(): Promise<boolean> {
    return Promise.resolve(true);
  },

  listen(callback: (isOnline: boolean) => void): () => void {
    queueMicrotask(() => {
      callback(true);
    });
    return () => undefined;
  },
};

function installBrowserGlobals(): () => void {
  const hadWindow = Reflect.has(globalThis, "window");
  const previousWindow = Reflect.get(globalThis, "window");
  if (!hadWindow) {
    Reflect.set(globalThis, "window", {
      location: {
        href: "http://localhost/",
        hostname: "localhost",
        search: "",
      },
    });
  }
  return () => {
    if (hadWindow) {
      Reflect.set(globalThis, "window", previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  };
}

function withoutBroadcastChannel<T>(fn: () => T): T {
  const hadBroadcastChannel = Reflect.has(globalThis, "BroadcastChannel");
  const previousBroadcastChannel = Reflect.get(globalThis, "BroadcastChannel");
  Reflect.set(globalThis, "BroadcastChannel", undefined);
  try {
    return fn();
  } finally {
    if (hadBroadcastChannel) {
      Reflect.set(globalThis, "BroadcastChannel", previousBroadcastChannel);
    } else {
      Reflect.deleteProperty(globalThis, "BroadcastChannel");
    }
  }
}
