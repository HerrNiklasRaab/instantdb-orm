import { beforeAll, describe, expect, it as vitIt } from "vitest";
import { configureEntityMeta } from "../../src/object-graph";
import schema from "../support/instant.schema";
import { User } from "../support/entities/User";
import { UserProfile } from "../support/entities/Profile";
import { Post } from "../support/entities/Post";
import { Tag } from "../support/entities/Tag";
import { ChessInvitation } from "../support/entities/ChessInvitation";
import { SkiInvitation } from "../support/entities/SkiInvitation";
import { ChessMatch } from "../support/entities/ChessMatch";
import { SkiMatch } from "../support/entities/SkiMatch";
import { Container } from "../support/entities/Container";
import { Item } from "../support/entities/Item";
import { withTestTransaction } from "../../src/testing";

beforeAll(() => {
  configureEntityMeta(schema as Parameters<typeof configureEntityMeta>[0]);
});

// Auto-wrap every `it` body in a tx context — Model enforces tx-only
// mutations, but these in-memory tests never hit a RootStore.
const it = (name: string, fn: () => void): void =>
  { vitIt(name, () => { withTestTransaction(fn); }); };

describe("Reverse link wiring (in-memory)", () => {
  // ---------------------------------------------------------------------------
  // Group A — Constructor-time wiring (relationship set BEFORE initTracking)
  // ---------------------------------------------------------------------------
  describe("Group A — constructor-time wiring", () => {
    it("A1: assigning a relationship inside the constructor populates the reverse side", () => {
      const author = new User("Alice");
      const post = new Post("Hello", author);

      expect(post.author).toBe(author);
      expect(author.posts).toContain(post);
      expect(author.posts).toHaveLength(1);
    });

    it("A2: two children constructed against the same parent both appear in the reverse array, in order, no duplicates", () => {
      const author = new User("Alice");
      const post1 = new Post("First", author);
      const post2 = new Post("Second", author);

      expect(author.posts).toHaveLength(2);
      expect(author.posts[0]).toBe(post1);
      expect(author.posts[1]).toBe(post2);
    });

    it("A2b: constructing the same child twice against the same parent does not duplicate (defensive)", () => {
      const author = new User("Alice");
      const post = new Post("Hello", author);
      // Manually re-trigger wiring by re-assigning to the same value
      post.author = author;

      expect(author.posts).toHaveLength(1);
      expect(author.posts[0]).toBe(post);
    });

    it("A4: child built inside a still-running parent constructor — wirer defers to parent's own initTracking sweep, no duplicate", () => {
      // Container's constructor builds Items inline, passing `this` (a not-yet-tracked
      // Container) into each Item. The Item's own initTracking sweep would try to wire
      // itself into container.items — but the parent isn't ready yet, so the wirer must
      // defer. The Container constructor's explicit `this.items.push(...)` is the only
      // population path. If the guard at reverseLinkWiring.ts:21 missed this case, each
      // item would appear twice (once from the wirer, once from the explicit push).
      const container = new Container("box", ["a", "b", "c"]);

      expect(container.items).toHaveLength(3);
      expect(container.items.map((i) => i.name)).toEqual(["a", "b", "c"]);
      // Forward refs from each item must still point back to the container
      // (set in Item's own constructor before initTracking).
      for (const item of container.items) {
        expect(item.container).toBe(container);
      }
      // No duplicates by identity either
      expect(new Set(container.items).size).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Group B — Setter wiring (relationship assigned AFTER construction)
  // ---------------------------------------------------------------------------
  describe("Group B — setter wiring", () => {
    it("B1: assigning a to-one ref after construction populates the reverse to-many array", () => {
      const inviter = new User("Inviter");
      const invitation = new ChessInvitation("5+0", true);

      invitation.inviter = inviter;

      expect(inviter.invitations).toContain(invitation);
      expect(inviter.invitations).toHaveLength(1);
    });

    it("B2: reassigning a to-one ref moves the back-ref between owners", () => {
      const m1 = new User("M1");
      const m2 = new User("M2");
      const invitation = new ChessInvitation("5+0", true);

      invitation.inviter = m1;
      expect(m1.invitations).toContain(invitation);

      invitation.inviter = m2;
      expect(m1.invitations).not.toContain(invitation);
      expect(m2.invitations).toContain(invitation);
      expect(m1.invitations).toHaveLength(0);
      expect(m2.invitations).toHaveLength(1);
    });

    it("B3: nulling a to-one ref removes the entry from the previous owner's array", () => {
      const inviter = new User("Inviter");
      const invitation = new ChessInvitation("5+0", true);

      invitation.inviter = inviter;
      invitation.inviter = null;

      expect(inviter.invitations).not.toContain(invitation);
      expect(inviter.invitations).toHaveLength(0);
      expect(invitation.inviter).toBeNull();
    });

    it("B4: assigning the same value twice is idempotent (no duplicate in reverse array)", () => {
      const inviter = new User("Inviter");
      const invitation = new ChessInvitation("5+0", true);

      invitation.inviter = inviter;
      invitation.inviter = inviter;

      expect(inviter.invitations).toHaveLength(1);
    });

    it("B5: 1:1 link wires both directions when assigning from the user side", () => {
      const user = new User("Alice");
      const profile = new UserProfile();

      user.profile = profile;

      expect(profile.user).toBe(user);
    });

    it("B5b: 1:1 link wires both directions when assigning from the profile side", () => {
      const user = new User("Alice");
      const profile = new UserProfile();

      profile.user = user;

      expect(user.profile).toBe(profile);
    });

    it("B6: STI subclasses share the reverse array on the parent", () => {
      const inviter = new User("Inviter");
      const chess = new ChessInvitation("5+0", true);
      const ski = new SkiInvitation("Zermatt", "expert");

      chess.inviter = inviter;
      ski.inviter = inviter;

      expect(inviter.invitations).toHaveLength(2);
      expect(inviter.invitations).toContain(chess);
      expect(inviter.invitations).toContain(ski);
    });

    it("B7: MTI subclasses wire into separate per-table arrays", () => {
      const inviter = new User("Inviter");
      const chess = new ChessMatch("5+0", true);
      const ski = new SkiMatch("Zermatt", "expert");

      chess.inviter = inviter;
      ski.inviter = inviter;

      expect(inviter.chessMatchs).toEqual([chess]);
      expect(inviter.skiMatchs).toEqual([ski]);
    });
  });

  // ---------------------------------------------------------------------------
  // Group C — Array mutation wiring (mutating the to-many side)
  // ---------------------------------------------------------------------------
  describe("Group C — array mutation wiring", () => {
    it("C1: pushing onto the to-many array sets the to-one ref on the child", () => {
      const inviter = new User("Inviter");
      const invitation = new ChessInvitation("5+0", true);

      inviter.invitations.push(invitation);

      expect(invitation.inviter).toBe(inviter);
    });

    it("C2: splicing from the to-many array nulls the to-one ref on the removed child", () => {
      const inviter = new User("Inviter");
      const invitation = new ChessInvitation("5+0", true);
      invitation.inviter = inviter;

      inviter.invitations.splice(0, 1);

      expect(invitation.inviter).toBeNull();
      expect(inviter.invitations).toHaveLength(0);
    });

    it("C3: pushing the same child twice is idempotent", () => {
      const inviter = new User("Inviter");
      const invitation = new ChessInvitation("5+0", true);

      inviter.invitations.push(invitation);
      inviter.invitations.push(invitation);

      expect(inviter.invitations).toHaveLength(1);
    });

    it("C4: clearing the array via length=0 nulls every removed child's to-one ref", () => {
      const inviter = new User("Inviter");
      const a = new ChessInvitation("5+0", true);
      const b = new ChessInvitation("3+2", false);
      a.inviter = inviter;
      b.inviter = inviter;

      inviter.invitations.length = 0;

      expect(a.inviter).toBeNull();
      expect(b.inviter).toBeNull();
      expect(inviter.invitations).toHaveLength(0);
    });

    it("C5: pushing onto a new owner's array reassigns the to-one ref away from the previous owner", () => {
      const m1 = new User("M1");
      const m2 = new User("M2");
      const invitation = new ChessInvitation("5+0", true);
      invitation.inviter = m1;

      m2.invitations.push(invitation);

      expect(invitation.inviter).toBe(m2);
      expect(m1.invitations).not.toContain(invitation);
      expect(m2.invitations).toContain(invitation);
    });
  });

  // ---------------------------------------------------------------------------
  // Group E — Many-to-many
  // ---------------------------------------------------------------------------
  describe("Group E — many-to-many wiring", () => {
    it("E1: pushing onto post.tags adds the post to tag.posts", () => {
      const post = new Post("Hello");
      const tag = new Tag("news");

      post.tags.push(tag);

      expect(tag.posts).toContain(post);
      expect(tag.posts).toHaveLength(1);
    });

    it("E2: pushing onto tag.posts adds the tag to post.tags (symmetric from either side)", () => {
      const post = new Post("Hello");
      const tag = new Tag("news");

      tag.posts.push(post);

      expect(post.tags).toContain(tag);
      expect(post.tags).toHaveLength(1);
    });

    it("E3: splicing from one side removes from the other; no duplicates on repeated pushes", () => {
      const post = new Post("Hello");
      const tag = new Tag("news");

      post.tags.push(tag);
      post.tags.push(tag); // idempotent
      expect(post.tags).toHaveLength(1);
      expect(tag.posts).toHaveLength(1);

      post.tags.splice(0, 1);

      expect(post.tags).toHaveLength(0);
      expect(tag.posts).not.toContain(post);
      expect(tag.posts).toHaveLength(0);
    });

    it("E4: a tag can sit on multiple posts and a post can carry multiple tags", () => {
      const post1 = new Post("First");
      const post2 = new Post("Second");
      const tag1 = new Tag("news");
      const tag2 = new Tag("featured");

      post1.tags.push(tag1);
      post1.tags.push(tag2);
      post2.tags.push(tag1);

      expect(tag1.posts).toEqual(expect.arrayContaining([post1, post2]));
      expect(tag1.posts).toHaveLength(2);
      expect(tag2.posts).toEqual([post1]);
      expect(post1.tags).toHaveLength(2);
      expect(post2.tags).toEqual([tag1]);
    });
  });

  // ---------------------------------------------------------------------------
  // Group F — Edge cases
  // ---------------------------------------------------------------------------
  describe("Group F — edge cases", () => {
    it("F1: wiring is idempotent across the cycle (no infinite loop or duplicate entries)", () => {
      const inviter = new User("Inviter");
      const invitation = new ChessInvitation("5+0", true);

      // If the wirer recurses without an idempotency check, this throws or stack-overflows.
      invitation.inviter = inviter;

      expect(inviter.invitations).toHaveLength(1);
      expect(invitation.inviter).toBe(inviter);
    });

    it("F3: self-referential 1:N — userA.referredBy = userB populates userB.referrals", () => {
      const userA = new User("A");
      const userB = new User("B");

      userA.referredBy = userB;

      expect(userB.referrals).toContain(userA);
      expect(userB.referrals).toHaveLength(1);
      // Don't accidentally cross-wire: userA's own referrals must still be empty
      expect(userA.referrals).toHaveLength(0);
    });

    it("F3b: self-referential reassignment moves the entry between owners", () => {
      const userA = new User("A");
      const userB = new User("B");
      const userC = new User("C");

      userA.referredBy = userB;
      userA.referredBy = userC;

      expect(userB.referrals).not.toContain(userA);
      expect(userC.referrals).toContain(userA);
    });

    it("F3c: self-referential null-out removes the back-ref", () => {
      const userA = new User("A");
      const userB = new User("B");

      userA.referredBy = userB;
      userA.referredBy = null;

      expect(userB.referrals).toHaveLength(0);
      expect(userA.referredBy).toBeNull();
    });

    // -------------------------------------------------------------------------
    // Symmetric case to A4. A4 protects against the wirer writing back to a
    // *parent* that is mid-construction (its own constructor will populate).
    // Here the *child* is mid-construction and a fully-tracked party pushes
    // it into its observable collection — the wirer should propagate the
    // back-ref. The narrower guard (`_disposers == null` AND we're inside
    // some model's `wireConstructorRelationships` sweep) distinguishes the
    // two cases by call-stack location.
    // -------------------------------------------------------------------------
    vitIt("F4: external push of mid-construction child wires child's back-ref", () => { withTestTransaction(() => {
      const container = new Container("box", []);

      // Mid-construction stand-in: prototype is there but no initializers ran.
      const midItem = Object.create(Item.prototype) as Item;

      container.items.push(midItem);

      expect(container.items).toContain(midItem);
      // The wirer runs outside any constructor sweep, so the narrower guard
      // lets it write `midItem.container = container` instead of skipping.
      expect(midItem.container).toBe(container);
    }); });
  });
});
