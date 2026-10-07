import { describe, it, expect } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { assertDefined, connectTestClient, wait, waitFor } from "./support/clients";
import { Post } from "../support/entities/Post";
import { Device } from "./support/Device";

const REPLY_LATENCY_MS = 100;
const SETTLE_MS = 300;

describe("Rebasing local writes", () => {
  // Two stores on one client: one queries, the other writes before the query
  // is answered. The answer predates the write, and must not show through.
  it("rebases a local write onto a query answer the server composed before it, so a subscription never shows it undone", async () => {
    const post = await new RootStore({ client: connectTestClient() }).transaction(() => new Post("Old"));
    const client = connectTestClient({ replyLatencyMs: REPLY_LATENCY_MS });
    const reader = new RootStore({ client });
    const writer = new RootStore({ client });
    await writer.queryModel(Post);
    const shown: string[] = [];
    const unsubscribe = client.subscribe({ posts: { where: { id: post.id } } }, ({ data }) => {
      const title = data?.posts?.[0]?.title;
      if (typeof title === "string") shown.push(title);
    });
    await waitFor(() => shown.includes("Old"));

    const query = reader.query({ posts: { where: { id: post.id } } });
    await wait(REPLY_LATENCY_MS / 10);
    const mine = writer.getById(Post, post.id);
    assertDefined(mine);
    await writer.transaction(() => { mine.title = "New"; });
    await query;
    await wait(SETTLE_MS);
    unsubscribe();

    const firstNew = shown.indexOf("New");
    expect(firstNew).toBeGreaterThan(-1);
    expect(shown.slice(firstNew)).not.toContain("Old");
  });

  // Offline, the device edits a post's title; meanwhile another client edits
  // its content. On reconnect the server's catch-up (the other client's
  // content, the old title) arrives before the verdict on the device's own
  // write, and must not show through either.
  it("rebases a local write onto rows the server pushes before confirming it, so a subscription never shows it undone", async () => {
    const author = new RootStore({ client: connectTestClient() });
    const { result: post } = await author.transaction(() => new Post("Old")).settled();
    const device = await Device.open();
    const store = device.store();
    await store.queryModel(Post);
    const shown: string[] = [];
    const unsubscribe = device.client.subscribe({ posts: { where: { id: post.id } } }, ({ data }) => {
      const title = data?.posts?.[0]?.title;
      if (typeof title === "string") shown.push(title);
    });
    await waitFor(() => shown.includes("Old"));
    const mine = store.getById(Post, post.id);
    assertDefined(mine);

    device.goOffline();
    const edit = store.transaction(() => { mine.title = "New"; });
    await edit;
    await author.transaction(() => { post.content = "Theirs"; }).settled();
    device.goOnline();
    await edit.settled();
    unsubscribe();

    const firstNew = shown.indexOf("New");
    expect(firstNew).toBeGreaterThan(-1);
    expect(shown.slice(firstNew)).not.toContain("Old");
  });
});
