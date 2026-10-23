import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { connectTestClient, streamRoutes, waitFor, type TestStore } from "./support/clients";
import { StreamEndpoint } from "./support/StreamEndpoint";
import { Post } from "../support/entities/Post";

/**
 * The HTTP stream transport, whichever transport the rest of the suite runs
 * on: two stores on their own streams to the same server, used exactly as an
 * app uses them.
 */
describe("Stream transport", () => {
  let endpoint: StreamEndpoint;

  beforeAll(async () => {
    endpoint = await StreamEndpoint.listen(streamRoutes);
  });

  afterAll(() => {
    endpoint.close();
  });

  function storeOverStream(): TestStore {
    return new RootStore({ client: connectTestClient({ open: () => endpoint.connect(null) }) });
  }

  it("carries one store's write to another", async () => {
    const writer = storeOverStream();
    const reader = storeOverStream();
    await reader.caughtUp();

    const post = await writer.transaction(() => new Post("Over the stream"));
    await reader.caughtUp();

    expect(reader.getById(Post, post.id)?.title).toBe("Over the stream");
  });

  it("commits a burst of writes in the order they were made", async () => {
    const writer = storeOverStream();
    const reader = storeOverStream();
    const titles = Array.from({ length: 20 }, (_, index) => `Post ${String(index)}`);

    const handles = titles.map((title) => writer.transaction(() => new Post(title)));
    const settled = await Promise.all(handles.map((handle) => handle.settled()));
    await reader.caughtUp();

    expect(settled.map(({ outcome }) => outcome.status)).toEqual(titles.map(() => "committed"));
    expect(settled.map(({ result }) => reader.getById(Post, result.id)?.title)).toEqual(titles);
  });

  it("reconnects after every stream is dropped and catches up on what it missed", async () => {
    const writer = storeOverStream();
    const reader = storeOverStream();
    await reader.caughtUp();

    endpoint.dropConnections();
    const { result: post, outcome } = await writer.transaction(() => new Post("Written across a drop")).settled();

    expect(outcome.status).toBe("committed");
    await waitFor(() => reader.getById(Post, post.id) !== undefined);
    expect(reader.getById(Post, post.id)?.title).toBe("Written across a drop");
  });
});
