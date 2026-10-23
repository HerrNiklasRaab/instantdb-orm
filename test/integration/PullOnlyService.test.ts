import { describe, expect, it } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { connectPullOnlyServiceClient, connectTestClient, PULL_ONLY_SERVICE, startServer, stopServer, waitFor } from "./support/clients";
import { Device } from "./support/Device";
import { Post } from "../support/entities/Post";

/**
 * A server process that reads per request wants the service's rights without
 * the service's replica: it must not be handed every row of a large table at
 * connect, nor every later change to it. Such a client pulls, writes, and is
 * told about its own writes only.
 */
describe("a pull-only service connection", () => {
  it("is sent nothing at connect and nothing later, and reads what it asks for", async () => {
    const writer = new RootStore({ client: connectTestClient() });
    const existing = await writer.transaction(() => new Post("Before the service connected"));
    await writer.transaction(() => new Post("Another one")).settled();

    const service = new RootStore({ client: connectPullOnlyServiceClient() });
    await service.caughtUp();
    expect(service.getAll(Post)).toEqual([]);

    const pulled = await service.queryModel(Post);
    expect(pulled.map((post) => post.title).sort()).toEqual(["Another one", "Before the service connected"]);

    const later = await writer.transaction(() => new Post("After the service connected")).settled();
    await service.caughtUp();
    expect(service.getById(Post, later.result.id)).toBeUndefined();
    expect(service.getById(Post, existing.id)?.title).toBe("Before the service connected");

    await service.query({ posts: { where: { id: later.result.id } } });
    expect(service.getById(Post, later.result.id)?.title).toBe("After the service connected");
  });

  it("writes like any client, and what it wrote reaches the clients that hold the bucket", async () => {
    const service = new RootStore({ client: connectPullOnlyServiceClient() });
    const reader = new RootStore({ client: connectTestClient() });
    await reader.caughtUp();

    const { result: post, outcome } = await service.transaction(() => new Post("From the service")).settled();
    await reader.caughtUp();

    expect(outcome.status).toBe("committed");
    expect(service.getById(Post, post.id)?.title).toBe("From the service");
    expect(reader.getById(Post, post.id)?.title).toBe("From the service");
  });

  it("reconnects after a server restart without a catch-up download", async () => {
    const writer = new RootStore({ client: connectTestClient() });
    const service = new RootStore({ client: connectPullOnlyServiceClient() });
    const pulled = await writer.transaction(() => new Post("Pulled before the restart")).settled();
    await service.query({ posts: { where: { id: pulled.result.id } } });

    await stopServer();
    await startServer();
    const missed = await writer.transaction(() => new Post("Written across the restart")).settled();
    const asked = await writer.transaction(() => new Post("Asked for after the restart")).settled();

    await waitFor(async () => {
      await service.query({ posts: { where: { id: asked.result.id } } });
      return service.getById(Post, asked.result.id) !== undefined;
    });
    expect(service.getById(Post, pulled.result.id)?.title).toBe("Pulled before the restart");
    expect(service.getById(Post, missed.result.id)).toBeUndefined();
  });

  it("sends a write made while offline once it is back, like any client", async () => {
    const device = await Device.open(PULL_ONLY_SERVICE);
    const service = device.store();
    const reader = new RootStore({ client: connectTestClient() });
    await reader.caughtUp();

    device.goOffline();
    const handle = service.transaction(() => new Post("Written offline by the service"));
    const post = await handle;
    device.goOnline();
    const { outcome } = await handle.settled();
    await reader.caughtUp();

    expect(outcome.status).toBe("committed");
    expect(reader.getById(Post, post.id)?.title).toBe("Written offline by the service");
  });

  it("is a property of the connection, not of the service's rights", async () => {
    const holding = new RootStore({ client: connectTestClient() });
    const pullOnly = new RootStore({ client: connectPullOnlyServiceClient() });
    const writer = new RootStore({ client: connectTestClient() });
    await Promise.all([holding.caughtUp(), pullOnly.caughtUp()]);

    const post = await writer.transaction(() => new Post("Seen by one of two service connections")).settled();
    await Promise.all([holding.caughtUp(), pullOnly.caughtUp()]);

    expect(holding.getById(Post, post.result.id)?.title).toBe("Seen by one of two service connections");
    expect(pullOnly.getById(Post, post.result.id)).toBeUndefined();
    await pullOnly.query({ posts: { where: { id: post.result.id } } });
    expect(pullOnly.getById(Post, post.result.id)?.title).toBe("Seen by one of two service connections");
  });
});
