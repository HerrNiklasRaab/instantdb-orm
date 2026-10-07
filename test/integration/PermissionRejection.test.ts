import { describe, it, expect } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import type { TransactionOutcome } from "../../src/transactions";
import {
  assertDefined,
  connectTestClient,
  connectTestClientAs,
  id,
  seedAuthUser,
  type TestStore,
} from "./support/clients";
import { User } from "../support/entities/User";
import { Post } from "../support/entities/Post";

/**
 * `users.update` is allowed only for the row's owner (see `schema.zmodel`).
 * An intruder's transaction that edits another user is denied by the server.
 * A denial is an outcome, not an exception: the transaction completes, is
 * undone locally and reported with the server's reason, and no other client
 * ever sees any part of it — not even the parts the intruder was allowed to
 * write.
 */
describe("Transactions without permission", () => {
  async function seedOwner(): Promise<{ ownerId: string; auditor: TestStore }> {
    const ownerId = await seedAuthUser(`owner-${id()}@example.com`);
    const admin = new RootStore({ client: connectTestClient() });
    await admin.transaction(() => new User("Owner", ownerId));
    return { ownerId, auditor: new RootStore({ client: connectTestClient() }) };
  }

  async function ownerAsSeenBy(store: TestStore, ownerId: string): Promise<User> {
    const owner = (await store.queryModel(User)).find((user) => user.id === ownerId);
    assertDefined(owner);
    return owner;
  }

  it("is denied by the server, undone locally and reported", async () => {
    const { ownerId, auditor } = await seedOwner();
    const denials: TransactionOutcome[] = [];
    const intruder = new RootStore({
      client: connectTestClientAs(`intruder-${id()}@example.com`),
      onTransactionDenied: (outcome) => { denials.push(outcome); },
    });
    const owner = await ownerAsSeenBy(intruder, ownerId);
    let smuggled: Post | undefined;

    const { outcome } = await intruder.transaction(() => {
      owner.name = "Hacked";
      smuggled = new Post("Allowed on its own");
    }).settled();

    expect(outcome.status).toBe("denied");

    expect(denials).toHaveLength(1);
    expect(denials[0]?.status).toBe("denied");
    expect(denials[0]?.reason).toMatch(/polic/i);

    expect(owner.name).toBe("Owner");
    assertDefined(smuggled);
    expect(intruder.getById(Post, smuggled.id)).toBeUndefined();

    expect((await ownerAsSeenBy(auditor, ownerId)).name).toBe("Owner");
    expect((await auditor.queryModel(Post)).some((post) => post.id === smuggled?.id)).toBe(false);
  });
});
