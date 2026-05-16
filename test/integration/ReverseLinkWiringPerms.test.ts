import { describe, it, expect } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import {
  setupTestDatabase,
  initTestDatabaseAsUser,
  seedAuthUser,
  id,
} from "./support/instantdb-test-utils";
import { User } from "../support/entities/User";
import { Post } from "../support/entities/Post";

/**
 * When the user code mutates the *forward* side of a relationship
 * (`post.author = otherUser`), reverse-link wiring eagerly mirrors that
 * onto the *wired* side (`otherUser.posts.push(post)`). Those wired-side
 * mutations are bookkeeping — the link op on the forward-side row is
 * what InstantDB persists. They should NOT cause the wired side's row to
 * be claimed and emitted as an `update` chunk, because the wired side is
 * a different user whose `update` perm rejects the actor.
 *
 * To pin this we tighten `users.update` to `isOwner` (see test
 * `instant.perms.ts`) and create a Post authored by *another* user from a
 * non-admin client. The transaction must succeed; if the wirer leaks an
 * update against the other user the perm-rule rejects the whole commit.
 */
describe("Reverse-link wiring perms", () => {
  it("does not emit an update chunk against the wired-side row when only the forward side was mutated", async () => {
    const adminDb = setupTestDatabase();
    const adminStore = new RootStore({ db: adminDb });

    // Two distinct $users users. Author email is the actor; otherUser is
    // the target of the reverse-wiring.
    const authorEmail = `author-${id()}@example.com`;
    const authorId = await seedAuthUser(authorEmail);
    const otherEmail = `other-${id()}@example.com`;
    const otherId = await seedAuthUser(otherEmail);

    // Seed both users into the `users` table with matching ids (admin
    // bypasses perms).
    await adminStore.transaction(() => {
      const author = new User("Author", authorId);
      const other = new User("Other", otherId);
      void author;
      void other;
    });

    // Hydrate the actor's view of `other` so the link target resolves
    // through their non-admin client.
    const actorDb = initTestDatabaseAsUser(authorEmail);
    const actorStore = new RootStore({ db: actorDb });
    const users = await actorStore.queryModel(User);
    const other = users.find((u) => u.id === otherId)!;

    // Create a Post whose `author` is the OTHER user. The wirer mirrors
    // this onto `other.posts[]`. Without the fix, this claims `other` and
    // commit emits an update on the `users` table for `other` →
    // `users.update = isOwner` rejects (actor is the author, not other).
    await expect(
      actorStore.transaction(() => {
        new Post(`post-${id()}`, other);
      }),
    ).resolves.not.toThrow();
  });
});
