import { describe, expect, it } from "vitest";
import { Model } from "../../src/object-graph/Model";
import { model } from "../../src/object-graph/decorators/model";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { LocalReplica, SyncClient } from "../../src/client";
import { inProcessSocketPair } from "../../src/protocol";
import { InMemoryPostgres, inMemorySqliteDialect } from "../../src/test";
import { schema, type SchemaType } from "../support/zenstack/client/schema";
import { schema as serverSchema } from "../support/zenstack/server/schema";
import { Invitation } from "../support/entities/Invitation";
import { ChessInvitation } from "../support/entities/ChessInvitation";
import { SkiInvitation } from "../support/entities/SkiInvitation";

// A production bundle does two things to this package that dev never does: it
// mangles class names (`Model` ships as `iy`) and it compiles the package once
// per server context, so the same class exists as several distinct objects.
// Both break identity checks that dev-mode tests can't see, so this file
// recreates them. The rename stands for the whole file, since that is what a
// minified bundle looks like.
Object.defineProperty(Model, "name", { value: "iy", configurable: true });

abstract class Trip extends Model {
  abstract get modelType(): string;
}

@model("invitations")
class HikeTrip extends Trip {
  get modelType(): "hike" {
    return "hike";
  }

  constructor(id?: string) {
    super(id);
    this.initTracking();
  }
}

@model("invitations")
class SailTrip extends Trip {
  get modelType(): "sail" {
    return "sail";
  }

  constructor(id?: string) {
    super(id);
    this.initTracking();
  }
}

/**
 * A second definition of a subclass already registered for "ski", standing in
 * for the duplicate class identity a bundler produces. It registers last, so
 * every hydrated ski row is built from this copy while callers importing
 * through the other bundle still hold the original class object.
 */
@model("invitations")
class SkiInvitationFromOtherBundle extends Invitation {
  get modelType(): "ski" {
    return "ski";
  }
}

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../support/zenstack/server/migrations");

async function bootStores(): Promise<{ writer: RootStore<SchemaType>; reader: RootStore<SchemaType> }> {
  const postgres = await InMemoryPostgres.start(migrationsDir);
  const server = await postgres.server(serverSchema);
  const connect = (): SyncClient<SchemaType> => {
    const [clientEnd, serverEnd] = inProcessSocketPair();
    server.accept(serverEnd, server.unrestricted());
    return new SyncClient(schema, () => clientEnd, LocalReplica.open(schema, inMemorySqliteDialect()));
  };
  return { writer: new RootStore({ client: connect() }), reader: new RootStore({ client: connect() }) };
}

describe("Single-table inheritance in a production bundle", () => {
  it("hydrates each row into the subclass its discriminator names", async () => {
    const { writer, reader } = await bootStores();
    const hike = await writer.transaction(() => new HikeTrip());
    const sail = await writer.transaction(() => new SailTrip());

    await reader.query({ invitations: {} });

    expect(reader.getAll(HikeTrip).map((t) => t.id)).toEqual([hike.id]);
    expect(reader.getAll(SailTrip).map((t) => t.id)).toEqual([sail.id]);
  });

  it("finds a hydrated subclass through the caller's copy of its class", async () => {
    const { writer, reader } = await bootStores();
    const written = await writer.transaction(() => new SkiInvitation("Zermatt", "advanced"));

    await reader.query({ invitations: {} });

    expect(reader.getAll(SkiInvitation).map((i) => i.id)).toEqual([written.id]);
  });

  it("finds the same row through either copy of the class", async () => {
    const { writer, reader } = await bootStores();
    const written = await writer.transaction(() => new SkiInvitation("Zermatt", "advanced"));

    await reader.query({ invitations: {} });

    expect(reader.getAll(SkiInvitationFromOtherBundle).map((i) => i.id)).toEqual([written.id]);
    expect(reader.getById(SkiInvitation, written.id)?.id).toBe(written.id);
  });

  it("keeps sibling subclasses of the same table apart", async () => {
    const { writer, reader } = await bootStores();
    const ski = await writer.transaction(() => new SkiInvitation("Zermatt", "advanced"));
    const chess = await writer.transaction(() => new ChessInvitation("5+0", true));

    await reader.query({ invitations: {} });

    expect(reader.getAll(ChessInvitation).map((i) => i.id)).toEqual([chess.id]);
    expect(reader.getAll(SkiInvitation).map((i) => i.id)).toEqual([ski.id]);
  });
});
