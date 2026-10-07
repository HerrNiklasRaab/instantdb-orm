import { describe, it, expect } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { connectTestClient, wait, waitFor } from "./support/clients";
import { Post } from "../support/entities/Post";

const HANDLER_WORK_MS = 100;
const SETTLE_MS = 300;

describe("Isolated subscription handlers", () => {
  // A reactor stamps what it sees. A second row lands while it is still busy
  // with the first, so a snapshot showing the first row unstamped is read
  // before the stamp lands and is only up for handling after it.
  it("never act on a snapshot older than their own last write", async () => {
    const reactor = new RootStore({ client: connectTestClient() });
    const stamped: string[] = [];
    const subscription = await reactor.subscribeQueryIsolated(
      { posts: { where: { content: null } } },
      async (curr) => {
        const unstamped = curr.getAll(Post);
        await wait(HANDLER_WORK_MS);
        await curr.transaction(() => {
          for (const post of unstamped) {
            post.content = "stamped";
            stamped.push(post.id);
          }
        });
      },
      { label: "Stamper" },
    );

    const author = new RootStore({ client: connectTestClient() });
    const first = await author.transaction(() => new Post("first"));
    await wait(HANDLER_WORK_MS / 5);
    const second = await author.transaction(() => new Post("second"));

    await waitFor(() => stamped.includes(first.id) && stamped.includes(second.id));
    await wait(SETTLE_MS);
    subscription.close();

    expect(stamped.filter((id) => id === first.id)).toHaveLength(1);
    expect(stamped.filter((id) => id === second.id)).toHaveLength(1);
  });
});
