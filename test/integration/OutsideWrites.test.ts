import { describe, it } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import {
  connectTestClient,
  id,
  startServer,
  stopServer,
  waitFor,
  writeStraightToPostgres,
} from "./support/clients";
import { Device } from "./support/Device";
import { User } from "../support/entities/User";

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
});
