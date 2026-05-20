import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import type { AppSchema } from "../support/instant.schema";
import {
  assertDefined,
  setupTestDatabase,
  type TestInstantDBClient,
} from "./support/instantdb-test-utils";
import { User } from "../support/entities/User";
import { Invitation } from "../support/entities/Invitation";
import { ChessInvitation } from "../support/entities/ChessInvitation";
import { SkiInvitation } from "../support/entities/SkiInvitation";

describe("Single Table Inheritance (Integration)", () => {
  let db: TestInstantDBClient;
  let storeA: RootStore<AppSchema>; // "Device A" - creates data
  let storeB: RootStore<AppSchema>; // "Device B" - hydrates data

  beforeEach(() => {
    db = setupTestDatabase();
    storeA = new RootStore<AppSchema>({ db });
    storeB = new RootStore<AppSchema>({ db });
  });

  // Helper to create user through Store A
  async function createUserInStoreA(
    data: Partial<{
      name: string;
    }> = {}
  ): Promise<User> {
    return storeA.transaction(() => new User(data.name ?? "Test User"));
  }

  // Helper to create ChessInvitation through Store A
  async function createChessInvitationInStoreA(
    data: Partial<{
      timeControl: string;
      rated: boolean;
    }> = {}
  ): Promise<ChessInvitation> {
    return storeA.transaction(
      () => new ChessInvitation(data.timeControl ?? "5+0", data.rated ?? true)
    );
  }

  // Helper to create SkiInvitation through Store A
  async function createSkiInvitationInStoreA(
    data: Partial<{
      resort: string;
      skillLevel: string;
    }> = {}
  ): Promise<SkiInvitation> {
    return storeA.transaction(
      () =>
        new SkiInvitation(
          data.resort ?? "Aspen",
          data.skillLevel ?? "intermediate"
        )
    );
  }

  describe("hydration with type discriminator", () => {
    it("hydrates mixed types from same table with correct class instances", async () => {
      // Store A creates both types
      const chessA = await createChessInvitationInStoreA({
        timeControl: "10+5",
        rated: false,
      });
      const skiA = await createSkiInvitationInStoreA({
        resort: "Vail",
        skillLevel: "beginner",
      });

      // Store B hydrates all invitations
      await storeB.query({ invitations: {} });

      const chess = storeB.getById(ChessInvitation, chessA.id);
      const ski = storeB.getById(SkiInvitation, skiA.id);

      // Each should be the correct subclass instance
      expect(chess).toBeInstanceOf(ChessInvitation);
      assertDefined(chess);
      expect(chess.modelType).toBe("chess");
      expect(chess.timeControl).toBe("10+5");

      expect(ski).toBeInstanceOf(SkiInvitation);
      assertDefined(ski);
      expect(ski.modelType).toBe("ski");
      expect(ski.resort).toBe("Vail");
    });
  });

  describe("relationships with inherited types", () => {
    it("sets forward relationship (subtype → User) correctly", async () => {
      // Create user and chess invitation with inviter link
      const user = await createUserInStoreA({ name: "Alice" });
      const chess = await createChessInvitationInStoreA({
        timeControl: "5+0",
        rated: true,
      });
      await storeA.transaction(() => {
        chess.inviter = user;
      });

      // Store B hydrates
      await storeB.query({ invitations: { inviter: {} } });

      const hydratedChess = storeB.getById(ChessInvitation, chess.id);
      const hydratedUser = storeB.getById(User, user.id);

      assertDefined(hydratedChess);
      expect(hydratedChess.inviter).toBe(hydratedUser);
    });

    it("sets reverse relationship (User → subtypes) correctly", async () => {
      // Create user with two different invitation types
      const user = await createUserInStoreA({ name: "Bob" });

      const chess = await createChessInvitationInStoreA({
        timeControl: "3+2",
        rated: false,
      });
      await storeA.transaction(() => {
        chess.inviter = user;
      });

      const ski = await createSkiInvitationInStoreA({
        resort: "Aspen",
        skillLevel: "advanced",
      });
      await storeA.transaction(() => {
        ski.inviter = user;
      });

      // Store B hydrates
      await storeB.query({ users: { invitations: {} } });

      const hydratedUser = storeB.getById(User, user.id);

      // User.invitations should contain both subtypes
      assertDefined(hydratedUser);
      expect(hydratedUser.invitations.length).toBe(2);
      expect(hydratedUser.invitations).toContainEqual(
        expect.any(ChessInvitation)
      );
      expect(hydratedUser.invitations).toContainEqual(
        expect.any(SkiInvitation)
      );
    });
  });

  describe("soft delete", () => {
    // Helper to mark entity as deleted directly in database
    async function markAsDeletedInDb(entityType: string, entityId: string) {
      await db.transact([
        db.tx[entityType][entityId].update({
          deletedAt: new Date().toISOString(),
        }),
      ]);
    }

    it("removes deleted STI entity from identity map", async () => {
      // Create entity
      const chess = await createChessInvitationInStoreA({ timeControl: "5+0" });

      // Hydrate in store B
      await storeB.query({ invitations: {} });
      expect(storeB.getById(ChessInvitation, chess.id)).toBeDefined();

      // Mark as deleted in DB (simulating deletion from another device)
      await markAsDeletedInDb("invitations", chess.id);

      // Re-hydrate - should be removed
      await storeB.query({ invitations: {} });
      expect(storeB.getById(ChessInvitation, chess.id)).toBeUndefined();
    });

    it("sets forward relationship to null when User is deleted (invitation.inviter → null)", async () => {
      // Create user and linked invitation
      const user = await createUserInStoreA({ name: "Alice" });
      const chess = await createChessInvitationInStoreA({ timeControl: "5+0" });
      await storeA.transaction(() => {
        chess.inviter = user;
      });

      // Hydrate in store B
      await storeB.query({ invitations: { inviter: {} } });
      const hydratedChess = storeB.getById(ChessInvitation, chess.id);
      assertDefined(hydratedChess);
      expect(hydratedChess.inviter).toBeDefined();

      // Delete user in DB
      await markAsDeletedInDb("users", user.id);

      // Re-hydrate - chess.inviter should be null
      await storeB.query({ users: {} });
      expect(hydratedChess.inviter).toBeNull();
    });

    it("removes deleted STI entity from reverse array (user.invitations)", async () => {
      // Create user with 2 invitations
      const user = await createUserInStoreA({ name: "Bob" });
      const chess1 = await createChessInvitationInStoreA({ timeControl: "3+2" });
      await storeA.transaction(() => {
        chess1.inviter = user;
      });

      const chess2 = await createChessInvitationInStoreA({ timeControl: "10+5" });
      await storeA.transaction(() => {
        chess2.inviter = user;
      });

      // Hydrate
      await storeB.query({ users: { invitations: {} } });
      const hydratedUser = storeB.getById(User, user.id);
      assertDefined(hydratedUser);
      expect(hydratedUser.invitations.length).toBe(2);

      // Delete one invitation
      await markAsDeletedInDb("invitations", chess1.id);

      // Re-hydrate - should only have 1 invitation
      await storeB.query({ invitations: {} });
      expect(hydratedUser.invitations.length).toBe(1);
      expect(hydratedUser.invitations[0].id).toBe(chess2.id);
    });

    it("handles mixed STI types in reverse array cleanup", async () => {
      // Create user with ChessInvitation + SkiInvitation
      const user = await createUserInStoreA({ name: "Charlie" });

      const chess = await createChessInvitationInStoreA({ timeControl: "5+0" });
      await storeA.transaction(() => {
        chess.inviter = user;
      });

      const ski = await createSkiInvitationInStoreA({ resort: "Aspen" });
      await storeA.transaction(() => {
        ski.inviter = user;
      });

      // Hydrate
      await storeB.query({ users: { invitations: {} } });
      const hydratedUser = storeB.getById(User, user.id);
      assertDefined(hydratedUser);
      expect(hydratedUser.invitations.length).toBe(2);

      // Delete ChessInvitation
      await markAsDeletedInDb("invitations", chess.id);

      // Re-hydrate
      await storeB.query({ invitations: {} });
      expect(hydratedUser.invitations.length).toBe(1);
      expect(hydratedUser.invitations[0]).toBeInstanceOf(SkiInvitation);
    });
  });

  describe("relationship removal", () => {
    it("clears forward 1:1 when set to null (invitation.inviter = null)", async () => {
      // Create linked entities
      const user = await createUserInStoreA({ name: "Dave" });
      const chess = await createChessInvitationInStoreA({ timeControl: "5+0" });
      await storeA.transaction(() => {
        chess.inviter = user;
      });

      // Clear the relationship
      await storeA.transaction(() => {
        chess.inviter = null;
      });

      // Verify in store B
      await storeB.query({ invitations: { inviter: {} } });
      const hydratedChess = storeB.getById(ChessInvitation, chess.id);
      assertDefined(hydratedChess);
      expect(hydratedChess.inviter).toBeNull();
    });

    it("removes from reverse 1:n when forward cleared", async () => {
      // Create linked entities
      const user = await createUserInStoreA({ name: "Eve" });
      const chess = await createChessInvitationInStoreA({ timeControl: "5+0" });
      await storeA.transaction(() => {
        chess.inviter = user;
      });

      // Hydrate and verify relationship
      await storeB.query({ users: { invitations: {} } });
      const hydratedUser = storeB.getById(User, user.id);
      assertDefined(hydratedUser);
      expect(hydratedUser.invitations.length).toBe(1);

      // Clear relationship in store A
      await storeA.transaction(() => {
        chess.inviter = null;
      });

      // Re-hydrate from user side to refresh reverse relationships
      await storeB.query({ users: { invitations: {} } });
      expect(hydratedUser.invitations.length).toBe(0);
    });
  });

  describe("polymorphic getAll", () => {
    it("should return all subclass instances when called with base class", async () => {
      await createChessInvitationInStoreA();
      await createSkiInvitationInStoreA();

      await storeB.query({ invitations: {} });

      const allInvitations = storeB.getAll(Invitation);

      expect(allInvitations.length).toBeGreaterThanOrEqual(2);
      expect(allInvitations).toContainEqual(expect.any(ChessInvitation));
      expect(allInvitations).toContainEqual(expect.any(SkiInvitation));
    });

    it("should still return only specific subclass when called with concrete class", async () => {
      await createChessInvitationInStoreA();
      await createSkiInvitationInStoreA();

      await storeB.query({ invitations: {} });

      const chessInvitations = storeB.getAll(ChessInvitation);
      const skiInvitations = storeB.getAll(SkiInvitation);

      expect(chessInvitations.length).toBeGreaterThanOrEqual(1);
      expect(skiInvitations.length).toBeGreaterThanOrEqual(1);
      expect(chessInvitations.every((r) => r instanceof ChessInvitation)).toBe(true);
      expect(skiInvitations.every((r) => r instanceof SkiInvitation)).toBe(true);
    });
  });

  // The schema declares an `invitations.opponent` link to users. Only
  // ChessInvitation declares the field; SkiInvitation does not. These
  // tests pin down how the hydrator treats per-subclass relationships.
  describe("per-subclass relationship fields", () => {
    it("storeA writes a subclass-declared relationship and storeB hydrates it", async () => {
      const opponent = await createUserInStoreA({ name: "Opponent" });
      const chess = await createChessInvitationInStoreA({ timeControl: "5+0" });
      await storeA.transaction(() => {
        chess.opponent = opponent;
      });

      await storeB.query({ invitations: { opponent: {} } });

      const hydratedChess = storeB.getById(ChessInvitation, chess.id);
      const hydratedOpponent = storeB.getById(User, opponent.id);

      assertDefined(hydratedChess);
      assertDefined(hydratedOpponent);
      expect(hydratedChess.opponent).toBe(hydratedOpponent);
    });

    it("assigns the schema relationship onto every concrete subclass, even ones that don't declare it", async () => {
      const ski = await createSkiInvitationInStoreA({ resort: "Vail" });

      await storeB.query({ invitations: { opponent: {} } });

      const hydratedSki = storeB.getById(SkiInvitation, ski.id);
      assertDefined(hydratedSki);
      // The hydrator walks schema relationships per-table, so SkiInvitation
      // receives `opponent = null` even though only ChessInvitation declares
      // the field. Pinned to current behavior; if the hydrator is later
      // taught to skip fields not declared on the resolved subclass, this
      // assertion flips to `toBeUndefined`.
      expect(Reflect.get(hydratedSki, "opponent")).toBeNull();
    });
  });
});
