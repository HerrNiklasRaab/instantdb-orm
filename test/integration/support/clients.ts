import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { afterAll, onTestFinished } from "vitest";
import { InMemoryPostgres, inMemorySqliteDialect, id as newId } from "@upfor/sync/test";
import { inProcessSocketPair, type Socket } from "../../../src/protocol";
import { testTransport } from "./env";
import { WebSocketEndpoint } from "./WebSocketEndpoint";
import { StreamEndpoint, type StreamRoutes } from "./StreamEndpoint";
import { LatentSocket } from "./LatentSocket";
import type { PausableSqlite } from "./PausableSqlite";
import { LocalReplica, SyncClient } from "../../../src/client";
import type { UntypedQuery } from "../../../src/queries";
import { RootStore } from "../../../src/object-graph/store/RootStore";
import { StreamAdmission, type Principal, type SyncServer } from "../../../src/server";
import { Lsn } from "../../../src/server/wal/Lsn";
import { isRecord } from "../../../src/queries";
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

/** Where the write-ahead log ends right now. */
export async function walPosition(): Promise<Lsn> {
  const [row] = await postgres.select("SELECT pg_current_wal_lsn()::text AS lsn");
  if (!isRecord(row) || typeof row.lsn !== "string") throw new Error("Postgres reported no WAL position.");
  return Lsn.parse(row.lsn);
}

/** The oldest WAL the sync server's replication slot still makes Postgres keep. */
export async function walRetainedFrom(): Promise<Lsn> {
  const [row] = await postgres.select("SELECT restart_lsn::text AS lsn FROM pg_replication_slots");
  if (!isRecord(row) || typeof row.lsn !== "string") throw new Error("The sync server has no replication slot.");
  return Lsn.parse(row.lsn);
}

export type TestClient = SyncClient<SchemaType>;

export type TestStore = RootStore<SchemaType>;

/** A store on a new client, holding everything the server had when it was opened. */
export async function syncedStore(): Promise<TestStore> {
  const store: TestStore = new RootStore({ client: connectTestClient() });
  await store.caughtUp();
  return store;
}

export interface InspectableClient {
  readonly client: TestClient;
  readonly replica: LocalReplica;
}

/** Stands in for the identity of a service connection that pulls but holds no bucket. */
export const PULL_ONLY_SERVICE = "~service:pull-only";

function principalFor(identityId: string | null): Principal {
  return identityId === null || identityId === PULL_ONLY_SERVICE ? server.unrestricted() : server.principal({ id: identityId });
}

/** Hands a socket from any endpoint to whichever server is running now. */
export function acceptSocket(socket: Socket, identityId: string | null): void {
  server.accept(socket, principalFor(identityId), { pullOnly: identityId === PULL_ONLY_SERVICE });
}

const admissions = new WeakMap<SyncServer, StreamAdmission>();

function streamAdmission(): StreamAdmission {
  let admission = admissions.get(server);
  if (admission === undefined) {
    admission = new StreamAdmission(server);
    admissions.set(server, admission);
  }
  return admission;
}

/** The stream transport's routes, always on whichever server is running now. */
export const streamRoutes: StreamRoutes = {
  open: (identityId, signal) => streamAdmission().open(principalFor(identityId), signal, { pullOnly: identityId === PULL_ONLY_SERVICE }),
  deliver: (connection, identityId, body) => streamAdmission().deliver(connection, principalFor(identityId), body),
  dropAll: () => { streamAdmission().close(); },
};

async function listen(): Promise<WebSocketEndpoint | StreamEndpoint | null> {
  switch (testTransport()) {
    case "websocket":
      return WebSocketEndpoint.listen(acceptSocket);
    case "stream":
      return StreamEndpoint.listen(streamRoutes);
    case "in-process":
      return null;
  }
}

const endpoint = await listen();

afterAll(() => {
  endpoint?.close();
});

export function openSocket(identityId: string | null): Socket {
  if (down) throw new Error("server is down");
  if (endpoint) return endpoint.connect(identityId);
  const [clientEnd, serverEnd] = inProcessSocketPair();
  acceptSocket(serverEnd, identityId);
  return clientEnd;
}

/** How the connection and the device behave; by default, answers arrive as soon as the server has them. */
export interface ConnectionOptions {
  /** Every frame from the server is held back this long, in order. */
  readonly replyLatencyMs?: number;
  /** The device's SQLite; a fresh in-memory one by default. */
  readonly sqlite?: PausableSqlite;
  /** Where the client connects; the suite's endpoint by default. */
  readonly open?: () => Socket;
}

function connect(
  identityId: string | null,
  replica: LocalReplica | Promise<LocalReplica>,
  options: ConnectionOptions = {},
): TestClient {
  const latencyMs = options.replyLatencyMs;
  const open = (): Socket => {
    const socket = options.open === undefined ? openSocket(identityId) : options.open();
    return latencyMs === undefined ? socket : new LatentSocket(socket, latencyMs);
  };
  const client = new SyncClient(schema, open, replica);
  // A client left open keeps receiving every later commit, and the server reads
  // its visible rows for each one: by the end of a file that is dozens of
  // connections queued in front of the test's own round trip. Bound to the test
  // that opened it, so tests may also run concurrently.
  onTestFinished(() => { client.close(); });
  return client;
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

/** A service client that is sent nothing it did not ask for. */
export function connectPullOnlyServiceClient(options: ConnectionOptions = {}): TestClient {
  return connect(PULL_ONLY_SERVICE, openReplica(options), options);
}

/** A new client — its own SQLite replica and connection — acting as the user registered under `email`. */
export function connectTestClientAs(email: string, options: ConnectionOptions = {}): TestClient {
  return connect(identities.register(email), openReplica(options), options);
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
