import { describe, it, expect, beforeEach } from "vitest";
import {
  setupTestDatabase,
  waitFor,
  type TestInstantDBClient,
} from "./support/instantdb-test-utils";
import { RootStore } from "../../src/object-graph/store/RootStore";
import type { AppSchema } from "../support/instant.schema";
import { Post } from "../support/entities/Post";
import { Tag } from "../support/entities/Tag";
import { User } from "../support/entities/User";
import { UserProfile } from "../support/entities/Profile";

// A subscription snapshot produced before a transaction commits cannot contain
// that transaction's work. Reconciling it must not destroy the pending state —
// evictions fire the reverse-link wiring, sever the uncommitted links, and the
// commit then persists rows without them.
//
// See ./PendingNewHydration.md for the production incident and design record
// behind this suite.
describe("subscription snapshots during a pending-new commit", () => {
  let db: TestInstantDBClient;

  beforeEach(() => {
    db = setupTestDatabase();
  });

  function makeStores(): { store: RootStore<AppSchema>; writer: RootStore<AppSchema> } {
    return {
      store: new RootStore<AppSchema>({ db }),
      writer: new RootStore<AppSchema>({ db }),
    };
  }

  it("keeps a pending-new member of a link array the snapshot cannot know yet", async () => {
    const { store, writer } = makeStores();
    const user = await store.transaction(() => new User("Alice"));
    await store.subscribeModel(User, () => {});

    await store.transaction(async () => {
      const post = new Post("Hello", user);

      const marker = await writer.transaction(() => new User("Bob"));
      await waitFor(() => store.getById(User, marker.id) != null);

      expect(user.posts).toContain(post);
      expect(post.author).toBe(user);
    });
  });

  it("does not dissolve a pending link between two persisted models", async () => {
    const { store, writer } = makeStores();
    const { post, tag } = await store.transaction(() => ({
      post: new Post("Hello"),
      tag: new Tag("news"),
    }));
    await store.subscribeModel(Post, () => {});

    await store.transaction(async () => {
      tag.posts.push(post);

      const marker = await writer.transaction(() => new Post("marker"));
      await waitFor(() => store.getById(Post, marker.id) != null);

      expect(post.tags).toContain(tag);
      expect(tag.posts).toContain(post);
    });
  });

  it("does not restore a replaced to-one link while the replacement is pending", async () => {
    const { store, writer } = makeStores();
    const user = await store.transaction(() => {
      const created = new User("Alice");
      const oldProfile = new UserProfile();
      oldProfile.user = created;
      return created;
    });
    await store.subscribeModel(User, () => {});

    await store.transaction(async () => {
      const newProfile = new UserProfile();
      newProfile.user = user;

      const marker = await writer.transaction(() => new User("Bob"));
      await waitFor(() => store.getById(User, marker.id) != null);

      expect(user.profile).toBe(newProfile);
      expect(newProfile.user).toBe(user);
    });
  });
});
