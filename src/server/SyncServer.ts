import type { DatabaseClient } from "../schema/DatabaseClient";
import type { SchemaDef } from "@zenstackhq/schema";
import { BucketScheme } from "../buckets/BucketScheme";
import type { Filing } from "./Filing";
import { HeldBuckets } from "../buckets/HeldBuckets";
import { ParameterQueries } from "../buckets/ParameterQueries";
import type { Socket } from "../protocol";
import { RowStore } from "../storage/RowStore";
import { BucketLog } from "./BucketLog";
import { ChangeFeed } from "./ChangeFeed";
import { ClientConnection } from "./ClientConnection";
import { RestrictedFieldMask } from "./RestrictedFieldMask";
import { Principal } from "./Principal";
import { PresenceRooms } from "./PresenceRooms";
import { ReplicatedTables } from "./wal/ReplicatedTables";

export interface SyncIdentity {
  readonly id: string;
}

export interface ZenStackClients {
  /** Bypasses access policies — server-side code only, never a device. */
  readonly unrestricted: DatabaseClient;
  /** A policy-enforcing client acting as `identity` (`null` = anonymous). */
  forIdentity(identity: SyncIdentity | null): DatabaseClient;
}

/**
 * Owns the database, the transaction log and the bucket log, and tells each
 * connected client about the changes in the buckets it holds. It learns of
 * changes from the WAL (`ChangeFeed`), so writes it did not make itself
 * reach clients too. Every client, backend code included, reaches it through
 * a socket handed to `accept` together with the `Principal` the caller has
 * authenticated it as. `start` before accepting anyone.
 */
export class SyncServer<Schema extends SchemaDef = SchemaDef> {
  private readonly connections = new Set<ClientConnection>();
  private readonly parameterQueries: ParameterQueries;
  readonly mask: RestrictedFieldMask;
  readonly scheme: BucketScheme;
  readonly bucketLog: BucketLog;
  /** Reads that bypass access policies: the log, bucket keys, and telling "forbidden" from "missing". */
  readonly unrestrictedRows: RowStore;
  readonly feed: ChangeFeed;
  readonly presence = new PresenceRooms();

  constructor(
    readonly schema: Schema,
    private readonly clients: ZenStackClients,
  ) {
    this.mask = new RestrictedFieldMask(schema, clients.unrestricted);
    this.scheme = BucketScheme.compile(schema);
    this.bucketLog = new BucketLog(clients.unrestricted);
    this.parameterQueries = new ParameterQueries(clients.unrestricted);
    this.unrestrictedRows = new RowStore(schema, clients.unrestricted);
    this.feed = new ChangeFeed(this, clients.unrestricted, ReplicatedTables.of(schema));
  }

  /** Starts reading the WAL, first filing whatever was committed while no server was. */
  start(): Promise<void> {
    return this.feed.open();
  }

  get unrestrictedClient(): DatabaseClient {
    return this.clients.unrestricted;
  }

  announce(filing: Filing): void {
    for (const connection of this.connections) connection.announce(filing);
  }

  heldBy(principal: Principal): Promise<HeldBuckets> {
    if (principal.isUnrestricted) return Promise.resolve(HeldBuckets.all(this.scheme));
    return HeldBuckets.of(this.scheme, principal.authorId, this.parameterQueries);
  }

  principal(identity: SyncIdentity | null): Principal<Schema> {
    return new Principal(this.schema, this.clients.forIdentity(identity), identity?.id ?? null, this);
  }

  /** The service principal: server-side code with no identity, which sees everything. */
  unrestricted(): Principal<Schema> {
    return new Principal(this.schema, this.clients.unrestricted, null, this);
  }

  /** Stops serving: every connection is dropped and the WAL is no longer read. */
  async close(): Promise<void> {
    for (const connection of this.connections) connection.close();
    await this.feed.close();
  }

  /** Serves one authenticated socket as `principal`. */
  accept(socket: Socket, principal: Principal): void {
    const connection = new ClientConnection(this, socket, principal);
    this.connections.add(connection);
    connection.onClose(() => {
      this.connections.delete(connection);
      this.presence.leaveAll(connection);
    });
  }
}
