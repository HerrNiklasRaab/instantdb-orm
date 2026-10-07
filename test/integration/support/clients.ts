import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { afterAll } from "vitest";
import { InMemoryPostgres, inMemorySqliteDialect, id as newId } from "@upfor/sync/test";
import { inProcessSocketPair, type Socket } from "../../../src/protocol";
import { testTransport } from "./env";
import { WebSocketEndpoint } from "./WebSocketEndpoint";
import { LatentSocket } from "./LatentSocket";
import type { PausableSqlite } from "./PausableSqlite";
import { LocalReplica, SyncClient } from "../../../src/client";
import type { UntypedQuery } from "../../../src/queries";
import type { RootStore } from "../../../src/object-graph/store/RootStore";
import type { Principal, SyncServer } from "../../../src/server";
import type { SchemaDef } from "@zenstackhq/schema";
import { schema, type SchemaType } from "../../support/zenstack/client/schema";
import { schema as serverSchema } from "../../support/zenstack/server/schema";

import "../../support/entities/User";
import "../../support/entities/Profile";
import "../../support/entities/Post";
import "../../support/entities/Tag";
import "../../support/entities/Container";
import "../../support/entities/Item";
import "../../support/entities/ChessInvitation";
import "../../support/entities/SkiInvitation";
import "../../support/entities/ChessMatch";
import "../../support/entities/SkiMatch";
import "../../support/entities/Listing";
import "../../support/entities/RemappedListing";
import "../../support/entities/Appointment";
import "../../support/entities/ValidatingListing";
import "../../support/entities/Room";
import "../../support/entities/RoomMember";
import "../../support/entities/RoomMessage";

export { assertDefined, firstOrFail, id, flushMicrotasks, wait, waitFor } from "@upfor/sync/test";

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../support/zenstack/server/migrations");

const postgres = await InMemoryPostgres.start(migrationsDir);
let server: SyncServer = await postgres.server(serverSchema);

/**
 * A deploy, as the tests see it: new connections reach a server built from
 * `nextSchema` on the same database. Devices that reconnect land there.
 */
export async function redeployServer(nextSchema: SchemaDef): Promise<void> {
  await server.close();
  server = await postgres.server(nextSchema);
}

let down = false;

/** The server process goes away: its connections drop, and nobody can connect until `startServer`. */
export async function stopServer(): Promise<void> {
  down = true;
  await server.close();
}

/** A new server process on the same database, built from the schema the last one ran. */
export async function startServer(): Promise<void> {
  server = await postgres.server(server.schema);
  down = false;
}

/** A write by something that knows nothing of the sync server, such as the auth provider. */
export function writeStraightToPostgres(sql: string): Promise<void> {
  return postgres.execute(sql);
}

export type TestClient = SyncClient<SchemaType>;

export type TestStore = RootStore<SchemaType>;

export interface InspectableClient {
  readonly client: TestClient;
  readonly replica: LocalReplica;
}

function principalFor(identityId: string | null): Principal {
  return identityId === null ? server.unrestricted() : server.principal({ id: identityId });
}

const endpoint = testTransport() === "websocket"
  ? await WebSocketEndpoint.listen((socket, identityId) => { server.accept(socket, principalFor(identityId)); })
  : null;

afterAll(() => {
  endpoint?.close();
});

export function openSocket(identityId: string | null): Socket {
  if (down) throw new Error("server is down");
  if (endpoint) return endpoint.connect(identityId);
  const [clientEnd, serverEnd] = inProcessSocketPair();
  server.accept(serverEnd, principalFor(identityId));
  return clientEnd;
}

/** How the connection and the device behave; by default, answers arrive as soon as the server has them. */
export interface ConnectionOptions {
  /** Every frame from the server is held back this long, in order. */
  readonly replyLatencyMs?: number;
  /** The device's SQLite; a fresh in-memory one by default. */
  readonly sqlite?: PausableSqlite;
}

function connect(
  identityId: string | null,
  replica: LocalReplica | Promise<LocalReplica>,
  options: ConnectionOptions = {},
): TestClient {
  const latencyMs = options.replyLatencyMs;
  const open = (): Socket => {
    const socket = openSocket(identityId);
    return latencyMs === undefined ? socket : new LatentSocket(socket, latencyMs);
  };
  return new SyncClient(schema, open, replica);
}

export function openReplica(options: ConnectionOptions = {}): Promise<LocalReplica> {
  return LocalReplica.open(schema, options.sqlite?.dialect ?? inMemorySqliteDialect());
}

async function openClient(identityId: string | null): Promise<InspectableClient> {
  const replica = await openReplica();
  return { client: connect(identityId, replica), replica };
}

/** A client whose SQLite replica the test can inspect directly. */
export function openTestClient(): Promise<InspectableClient> {
  return openClient(null);
}

export function openTestClientAs(email: string): Promise<InspectableClient> {
  return openClient(identities.register(email));
}

/** The server's transaction log, oldest first. */
export function committedTransactions(): Promise<unknown[]> {
  return postgres.select('SELECT "tick", "id", "authorId", "status", "reason", "loggedAt" FROM "transactions" ORDER BY "tick"');
}

/** The logged changes of every transaction, in log order. */
export function committedChanges(): Promise<unknown[]> {
  return postgres.select(
    'SELECT c."transactionId", c."position", c."kind", c."entity", c."entityId", c."field", c."values", c."links", c."targetIds" '
    + 'FROM "changes" c JOIN "transactions" t ON t."id" = c."transactionId" ORDER BY t."tick", c."position"',
  );
}

/** Stands in for the auth provider: an email resolves to one stable user id. */
class TestIdentities {
  private readonly idsByEmail = new Map<string, string>();

  register(email: string): string {
    let userId = this.idsByEmail.get(email);
    if (!userId) {
      userId = newId();
      this.idsByEmail.set(email, userId);
    }
    return userId;
  }
}

const identities = new TestIdentities();

/** A new client — its own SQLite replica and connection — with service (unrestricted) access. */
export function connectTestClient(options: ConnectionOptions = {}): TestClient {
  return connect(null, openReplica(options), options);
}

/** A new client — its own SQLite replica and connection — acting as the user registered under `email`. */
export function connectTestClientAs(email: string): TestClient {
  return connect(identities.register(email), openReplica());
}

export function registerIdentity(email: string): string {
  return identities.register(email);
}

export function seedAuthUser(email: string): Promise<string> {
  return Promise.resolve(identities.register(email));
}

export function waitForSubscription<T>(
  client: TestClient,
  query: UntypedQuery,
  predicate: (data: unknown) => data is T,
  timeoutMs: number = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Subscription timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = client.subscribe(query, ({ error, data }) => {
      if (error) {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error(error.message));
        return;
      }
      if (predicate(data)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(data);
      }
    });
  });
}
