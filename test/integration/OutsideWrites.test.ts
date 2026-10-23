import { describe, expect, it } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import {
  committedTransactions,
  connectTestClient,
  id,
  startServer,
  stopServer,
  waitFor,
  walPosition,
  walRetainedFrom,
  writeStraightToPostgres,
} from "./support/clients";
import { Device } from "./support/Device";
import { mentions, person, RoomAdmin, watchMessages } from "./support/rooms";
import { User } from "../support/entities/User";

// More rows than one statement can bind.
const CATALOG_ROWS = 10_000;

function insertUser(userId: string, name: string): Promise<void> {
  return writeStraightToPostgres(
    `INSERT INTO "users" ("id", "name", "createdAt", "updatedAt") VALUES ('${userId}', '${name}', now(), now())`,
  );
}

describe("Writes made outside the sync server", () => {
  it("reaches a subscribed client when a row is inserted straight into Postgres", async () => {
    const store = new RootStore({ client: connectTestClient() });
    await store.subscribeModel(User, () => undefined);
    const userId = id();

    await insertUser(userId, "Lena");

    await waitFor(() => store.getById(User, userId)?.name === "Lena");
  });

  it("delivers writes made while the server was down once it is back", async () => {
    const device = await Device.open();
    const store = device.store();
    await store.subscribeModel(User, () => undefined);
    const userId = id();

    device.goOffline();
    await stopServer();
    await insertUser(userId, "Lena");
    await startServer();
    device.goOnline();

    await waitFor(() => store.getById(User, userId)?.name === "Lena");
  });

  it("files a catalog-sized load committed while the server was down as one transaction", async () => {
    const admin = new RoomAdmin();
    const bob = await person("Bob");
    const bobsRoom = await admin.createRoom("bob's room", [bob.userId]);
    const archive = await admin.createRoom("archive", []);
    const bobSees = await watchMessages(bob);
    const filedBefore = (await committedTransactions()).length;

    bob.device.goOffline();
    await stopServer();
    await writeStraightToPostgres(
      `INSERT INTO "roomMessages" ("id", "text", "roomId", "createdAt", "updatedAt")
       SELECT 'load-' || i, 'archived message ' || i, '${archive.id}', now(), now() FROM generate_series(1, ${CATALOG_ROWS}) AS i
       UNION ALL SELECT 'for-bob', 'hello bob', '${bobsRoom.id}', now(), now()`,
    );
    await startServer();
    const beforeReconnect = bob.device.framesReceived();
    bob.device.goOnline();

    await waitFor(() => bobSees.length === 1);
    expect(bobSees[0]?.text).toBe("hello bob");
    expect(mentions(bob.device.framesSince(beforeReconnect), "archived message")).toBe(false);
    expect(await committedTransactions()).toHaveLength(filedBefore + 1);
  });

  it("stops holding the WAL of a load once it is filed", async () => {
    const prefix = id();
    await stopServer();
    await writeStraightToPostgres(
      `INSERT INTO "users" ("id", "name", "createdAt", "updatedAt")
       SELECT '${prefix}-' || i, 'Row ' || i, now(), now() FROM generate_series(1, ${CATALOG_ROWS}) AS i`,
    );
    const loaded = await walPosition();
    await startServer();

    expect((await walRetainedFrom()).isBefore(loaded)).toBe(false);
  });
});
