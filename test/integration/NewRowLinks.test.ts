import { describe, expect, it } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { Post } from "../support/entities/Post";
import { User } from "../support/entities/User";
import { connectTestClient, waitFor } from "./support/clients";

describe("New rows linking to new rows", () => {
  it("lands a new row linked to a row the same transaction made after it", async () => {
    const writer = new RootStore({ client: connectTestClient() });
    const { post, author } = await writer.transaction(() => {
      const created = new Post("first");
      const user = new User("Lena");
      created.author = user;
      return { post: created, author: user };
    });

    const reader = new RootStore({ client: connectTestClient() });
    await waitFor(async () => {
      await reader.query({ posts: { where: { id: post.id }, include: { author: true } } });
      return reader.getById(Post, post.id) !== undefined;
    });
    expect(reader.getById(Post, post.id)?.author?.id).toBe(author.id);
  });

  it("lands two new rows that link to each other", async () => {
    const writer = new RootStore({ client: connectTestClient() });
    const [lena, max] = await writer.transaction(() => {
      const first = new User("Lena");
      const second = new User("Max");
      first.referredBy = second;
      second.referredBy = first;
      return [first, second];
    });

    const reader = new RootStore({ client: connectTestClient() });
    await waitFor(async () => (await reader.queryModel(User)).filter((stored) => stored.id === lena.id || stored.id === max.id).length === 2);
    expect(reader.getById(User, lena.id)?.referredBy?.id).toBe(max.id);
    expect(reader.getById(User, max.id)?.referredBy?.id).toBe(lena.id);
  });
});
