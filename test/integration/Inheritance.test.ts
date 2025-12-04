import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import {
  setupTestDatabase,
  id,
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
    entityId: string,
    data: Partial<{
      name: string;
      createdAt: Date;
      updatedAt: Date;
    }>
  ): Promise<User> {
    const user = new User(entityId, {
      name: data.name ?? "Test User",
      createdAt: data.createdAt ?? new Date(),
      updatedAt: data.updatedAt ?? new Date(),
    });
    await storeA.save(user);
    return user;
  }

  // Helper to create ChessMatchRequest through Store A
  async function createChessMatchInStoreA(
    entityId: string,
    data: Partial<{
      timeControl: string;
      rated: boolean;
      createdAt: Date;
    }>
  ): Promise<ChessMatchRequest> {
    const match = new ChessMatchRequest(entityId, {
      createdAt: data.createdAt ?? new Date(),
      timeControl: data.timeControl ?? "5+0",
      rated: data.rated ?? true,
    });
    await storeA.save(match);
    return match;
  }

  // Helper to create SkiMatchRequest through Store A
  async function createSkiMatchInStoreA(
    entityId: string,
    data: Partial<{
      resort: string;
      skillLevel: string;
      createdAt: Date;
    }>
  ): Promise<SkiMatchRequest> {
    const match = new SkiMatchRequest(entityId, {
      createdAt: data.createdAt ?? new Date(),
      resort: data.resort ?? "Aspen",
      skillLevel: data.skillLevel ?? "intermediate",
    });
    await storeA.save(match);
    return match;
  }

  describe("hydration with type discriminator", () => {
    it("hydrates mixed types from same table with correct class instances", async () => {
      const chessId = id();
      const skiId = id();

      // Store A creates both types
      await createChessMatchInStoreA(chessId, {
        timeControl: "10+5",
        rated: false,
      });
      await createSkiMatchInStoreA(skiId, {
        resort: "Vail",
        skillLevel: "beginner",
      });

      // Store B hydrates all matchRequests
      await storeB.query({ matchRequests: {} });

      const chess = storeB.getById(ChessMatchRequest, chessId);
      const ski = storeB.getById(SkiMatchRequest, skiId);

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
      const userId = id();
      const chessId = id();

      // Create user and chess match with requester link
      const user = await createUserInStoreA(userId, { name: "Alice" });
      const chess = await createChessMatchInStoreA(chessId, {
        timeControl: "5+0",
        rated: true,
      });
      chess.requester = user;
      await storeA.save(chess);

      // Store B hydrates
      await storeB.query({ matchRequests: { requester: {} } });

      const hydratedChess = storeB.getById(ChessMatchRequest, chessId);
      const hydratedUser = storeB.getById(User, userId);

      expect(hydratedChess!.requester).toBe(hydratedUser);
    });

    it("sets reverse relationship (User → subtypes) correctly", async () => {
      const userId = id();
      const chessId = id();
      const skiId = id();

      // Create user with two different match request types
      const user = await createUserInStoreA(userId, { name: "Bob" });

      const chess = await createChessMatchInStoreA(chessId, {
        timeControl: "3+2",
        rated: false,
      });
      chess.requester = user;
      await storeA.save(chess);

      const ski = await createSkiMatchInStoreA(skiId, {
        resort: "Aspen",
        skillLevel: "advanced",
      });
      ski.requester = user;
      await storeA.save(ski);

      // Store B hydrates
      await storeB.query({ users: { matchRequests: {} } });

      const hydratedUser = storeB.getById(User, userId);

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
      const chessId = id();

      // Create entity
      await createChessMatchInStoreA(chessId, { timeControl: "5+0" });

      // Hydrate in store B
      await storeB.query({ matchRequests: {} });
      expect(storeB.getById(ChessMatchRequest, chessId)).toBeDefined();

      // Mark as deleted in DB (simulating deletion from another device)
      await markAsDeletedInDb("matchRequests", chessId);

      // Re-hydrate - should be removed
      await storeB.query({ matchRequests: {} });
      expect(storeB.getById(ChessMatchRequest, chessId)).toBeUndefined();
    });

    it("sets forward relationship to null when User is deleted (match.requester → null)", async () => {
      const userId = id();
      const chessId = id();

      // Create user and linked match
      const user = await createUserInStoreA(userId, { name: "Alice" });
      const chess = await createChessMatchInStoreA(chessId, { timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      // Hydrate in store B
      await storeB.query({ matchRequests: { requester: {} } });
      const hydratedChess = storeB.getById(ChessMatchRequest, chessId);
      expect(hydratedChess!.requester).toBeDefined();

      // Delete user in DB
      await markAsDeletedInDb("users", userId);

      // Re-hydrate - chess.requester should be null
      await storeB.query({ users: {} });
      expect(hydratedChess!.requester).toBeNull();
    });

    it("removes deleted STI entity from reverse array (user.matchRequests)", async () => {
      const userId = id();
      const chess1Id = id();
      const chess2Id = id();

      // Create user with 2 match requests
      const user = await createUserInStoreA(userId, { name: "Bob" });
      const chess1 = await createChessMatchInStoreA(chess1Id, { timeControl: "3+2" });
      chess1.requester = user;
      await storeA.save(chess1);

      const chess2 = await createChessMatchInStoreA(chess2Id, { timeControl: "10+5" });
      chess2.requester = user;
      await storeA.save(chess2);

      // Hydrate
      await storeB.query({ users: { matchRequests: {} } });
      const hydratedUser = storeB.getById(User, userId);
      expect(hydratedUser!.matchRequests.length).toBe(2);

      // Delete one match request
      await markAsDeletedInDb("matchRequests", chess1Id);

      // Re-hydrate - should only have 1 match request
      await storeB.query({ matchRequests: {} });
      expect(hydratedUser!.matchRequests.length).toBe(1);
      expect(hydratedUser!.matchRequests[0]!.id).toBe(chess2Id);
    });

    it("handles mixed STI types in reverse array cleanup", async () => {
      const userId = id();
      const chessId = id();
      const skiId = id();

      // Create user with ChessMatchRequest + SkiMatchRequest
      const user = await createUserInStoreA(userId, { name: "Charlie" });

      const chess = await createChessMatchInStoreA(chessId, { timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      const ski = await createSkiMatchInStoreA(skiId, { resort: "Aspen" });
      ski.requester = user;
      await storeA.save(ski);

      // Hydrate
      await storeB.query({ users: { matchRequests: {} } });
      const hydratedUser = storeB.getById(User, userId);
      expect(hydratedUser!.matchRequests.length).toBe(2);

      // Delete ChessMatchRequest
      await markAsDeletedInDb("matchRequests", chessId);

      // Re-hydrate
      await storeB.query({ matchRequests: {} });
      expect(hydratedUser!.matchRequests.length).toBe(1);
      expect(hydratedUser!.matchRequests[0]).toBeInstanceOf(SkiMatchRequest);
    });
  });

  describe("relationship removal", () => {
    it("clears forward 1:1 when set to null (match.requester = null)", async () => {
      const userId = id();
      const chessId = id();

      // Create linked entities
      const user = await createUserInStoreA(userId, { name: "Dave" });
      const chess = await createChessMatchInStoreA(chessId, { timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      // Clear the relationship
      chess.requester = null;
      await storeA.save(chess);

      // Verify in store B
      await storeB.query({ matchRequests: { requester: {} } });
      const hydratedChess = storeB.getById(ChessMatchRequest, chessId);
      expect(hydratedChess!.requester).toBeNull();
    });

    it("removes from reverse 1:n when forward cleared", async () => {
      const userId = id();
      const chessId = id();

      // Create linked entities
      const user = await createUserInStoreA(userId, { name: "Eve" });
      const chess = await createChessMatchInStoreA(chessId, { timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      // Hydrate and verify relationship
      await storeB.query({ users: { matchRequests: {} } });
      const hydratedUser = storeB.getById(User, userId);
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
