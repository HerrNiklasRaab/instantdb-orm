import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import {
  setupTestDatabase,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";
import { User } from "../entities/User";
import { ChessMatchRequest } from "../entities/ChessMatchRequest";
import { SkiMatchRequest } from "../entities/SkiMatchRequest";

describe("Single Table Inheritance (Integration)", () => {
  let db: TestInstantDBClient;
  let storeA: RootStore; // "Device A" - creates data
  let storeB: RootStore; // "Device B" - hydrates data

  beforeEach(() => {
    db = setupTestDatabase();
    storeA = new RootStore({ db });
    storeB = new RootStore({ db });
  });

  // Helper to create user through Store A
  async function createUserInStoreA(
    data: Partial<{
      name: string;
      createdAt: Date;
      updatedAt: Date;
    }> = {}
  ): Promise<User> {
    const user = new User({
      name: data.name ?? "Test User",
      createdAt: data.createdAt ?? new Date(),
      updatedAt: data.updatedAt ?? new Date(),
    });
    await storeA.save(user);
    return user;
  }

  // Helper to create ChessMatchRequest through Store A
  async function createChessMatchInStoreA(
    data: Partial<{
      timeControl: string;
      rated: boolean;
      createdAt: Date;
    }> = {}
  ): Promise<ChessMatchRequest> {
    const match = new ChessMatchRequest({
      createdAt: data.createdAt ?? new Date(),
      timeControl: data.timeControl ?? "5+0",
      rated: data.rated ?? true,
    });
    await storeA.save(match);
    return match;
  }

  // Helper to create SkiMatchRequest through Store A
  async function createSkiMatchInStoreA(
    data: Partial<{
      resort: string;
      skillLevel: string;
      createdAt: Date;
    }> = {}
  ): Promise<SkiMatchRequest> {
    const match = new SkiMatchRequest({
      createdAt: data.createdAt ?? new Date(),
      resort: data.resort ?? "Aspen",
      skillLevel: data.skillLevel ?? "intermediate",
    });
    await storeA.save(match);
    return match;
  }

  describe("hydration with type discriminator", () => {
    it("hydrates mixed types from same table with correct class instances", async () => {
      // Store A creates both types
      const chessA = await createChessMatchInStoreA({
        timeControl: "10+5",
        rated: false,
      });
      const skiA = await createSkiMatchInStoreA({
        resort: "Vail",
        skillLevel: "beginner",
      });

      // Store B hydrates all matchRequests
      await storeB.query({ matchRequests: {} });

      const chess = storeB.getById(ChessMatchRequest, chessA.id);
      const ski = storeB.getById(SkiMatchRequest, skiA.id);

      // Each should be the correct subclass instance
      expect(chess).toBeInstanceOf(ChessMatchRequest);
      expect(chess!.type).toBe("chess");
      expect(chess!.timeControl).toBe("10+5");

      expect(ski).toBeInstanceOf(SkiMatchRequest);
      expect(ski!.type).toBe("ski");
      expect(ski!.resort).toBe("Vail");
    });
  });

  describe("relationships with inherited types", () => {
    it("sets forward relationship (subtype → User) correctly", async () => {
      // Create user and chess match with requester link
      const user = await createUserInStoreA({ name: "Alice" });
      const chess = await createChessMatchInStoreA({
        timeControl: "5+0",
        rated: true,
      });
      chess.requester = user;
      await storeA.save(chess);

      // Store B hydrates
      await storeB.query({ matchRequests: { requester: {} } });

      const hydratedChess = storeB.getById(ChessMatchRequest, chess.id);
      const hydratedUser = storeB.getById(User, user.id);

      expect(hydratedChess!.requester).toBe(hydratedUser);
    });

    it("sets reverse relationship (User → subtypes) correctly", async () => {
      // Create user with two different match request types
      const user = await createUserInStoreA({ name: "Bob" });

      const chess = await createChessMatchInStoreA({
        timeControl: "3+2",
        rated: false,
      });
      chess.requester = user;
      await storeA.save(chess);

      const ski = await createSkiMatchInStoreA({
        resort: "Aspen",
        skillLevel: "advanced",
      });
      ski.requester = user;
      await storeA.save(ski);

      // Store B hydrates
      await storeB.query({ users: { matchRequests: {} } });

      const hydratedUser = storeB.getById(User, user.id);

      // User.matchRequests should contain both subtypes
      expect(hydratedUser!.matchRequests.length).toBe(2);
      expect(hydratedUser!.matchRequests).toContainEqual(
        expect.any(ChessMatchRequest)
      );
      expect(hydratedUser!.matchRequests).toContainEqual(
        expect.any(SkiMatchRequest)
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
      const chess = await createChessMatchInStoreA({ timeControl: "5+0" });

      // Hydrate in store B
      await storeB.query({ matchRequests: {} });
      expect(storeB.getById(ChessMatchRequest, chess.id)).toBeDefined();

      // Mark as deleted in DB (simulating deletion from another device)
      await markAsDeletedInDb("matchRequests", chess.id);

      // Re-hydrate - should be removed
      await storeB.query({ matchRequests: {} });
      expect(storeB.getById(ChessMatchRequest, chess.id)).toBeUndefined();
    });

    it("sets forward relationship to null when User is deleted (match.requester → null)", async () => {
      // Create user and linked match
      const user = await createUserInStoreA({ name: "Alice" });
      const chess = await createChessMatchInStoreA({ timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      // Hydrate in store B
      await storeB.query({ matchRequests: { requester: {} } });
      const hydratedChess = storeB.getById(ChessMatchRequest, chess.id);
      expect(hydratedChess!.requester).toBeDefined();

      // Delete user in DB
      await markAsDeletedInDb("users", user.id);

      // Re-hydrate - chess.requester should be null
      await storeB.query({ users: {} });
      expect(hydratedChess!.requester).toBeNull();
    });

    it("removes deleted STI entity from reverse array (user.matchRequests)", async () => {
      // Create user with 2 match requests
      const user = await createUserInStoreA({ name: "Bob" });
      const chess1 = await createChessMatchInStoreA({ timeControl: "3+2" });
      chess1.requester = user;
      await storeA.save(chess1);

      const chess2 = await createChessMatchInStoreA({ timeControl: "10+5" });
      chess2.requester = user;
      await storeA.save(chess2);

      // Hydrate
      await storeB.query({ users: { matchRequests: {} } });
      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser!.matchRequests.length).toBe(2);

      // Delete one match request
      await markAsDeletedInDb("matchRequests", chess1.id);

      // Re-hydrate - should only have 1 match request
      await storeB.query({ matchRequests: {} });
      expect(hydratedUser!.matchRequests.length).toBe(1);
      expect(hydratedUser!.matchRequests[0]!.id).toBe(chess2.id);
    });

    it("handles mixed STI types in reverse array cleanup", async () => {
      // Create user with ChessMatchRequest + SkiMatchRequest
      const user = await createUserInStoreA({ name: "Charlie" });

      const chess = await createChessMatchInStoreA({ timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      const ski = await createSkiMatchInStoreA({ resort: "Aspen" });
      ski.requester = user;
      await storeA.save(ski);

      // Hydrate
      await storeB.query({ users: { matchRequests: {} } });
      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser!.matchRequests.length).toBe(2);

      // Delete ChessMatchRequest
      await markAsDeletedInDb("matchRequests", chess.id);

      // Re-hydrate
      await storeB.query({ matchRequests: {} });
      expect(hydratedUser!.matchRequests.length).toBe(1);
      expect(hydratedUser!.matchRequests[0]).toBeInstanceOf(SkiMatchRequest);
    });
  });

  describe("relationship removal", () => {
    it("clears forward 1:1 when set to null (match.requester = null)", async () => {
      // Create linked entities
      const user = await createUserInStoreA({ name: "Dave" });
      const chess = await createChessMatchInStoreA({ timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      // Clear the relationship
      chess.requester = null;
      await storeA.save(chess);

      // Verify in store B
      await storeB.query({ matchRequests: { requester: {} } });
      const hydratedChess = storeB.getById(ChessMatchRequest, chess.id);
      expect(hydratedChess!.requester).toBeNull();
    });

    it("removes from reverse 1:n when forward cleared", async () => {
      // Create linked entities
      const user = await createUserInStoreA({ name: "Eve" });
      const chess = await createChessMatchInStoreA({ timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      // Hydrate and verify relationship
      await storeB.query({ users: { matchRequests: {} } });
      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser!.matchRequests.length).toBe(1);

      // Clear relationship in store A
      chess.requester = null;
      await storeA.save(chess);

      // Re-hydrate from user side to refresh reverse relationships
      await storeB.query({ users: { matchRequests: {} } });
      expect(hydratedUser!.matchRequests.length).toBe(0);
    });
  });
});
