import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import {
  setupTestDatabase,
  id,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";
import { User } from "../entities/User";
import { ChessMatch } from "../entities/ChessMatch";
import { SkiMatch } from "../entities/SkiMatch";

describe("Multi-Table Inheritance (Integration)", () => {
  let db: TestInstantDBClient;
  let storeA: RootStore;
  let storeB: RootStore;

  beforeEach(() => {
    db = setupTestDatabase();
    storeA = new RootStore({ db });
    storeB = new RootStore({ db });
  });

  // Helper functions
  async function createChessMatchInStoreA(
    entityId: string,
    data: Partial<{
      createdAt: Date;
      timeControl: string;
      rated: boolean;
    }>
  ): Promise<ChessMatch> {
    const match = new ChessMatch(entityId, {
      createdAt: data.createdAt ?? new Date(),
      timeControl: data.timeControl ?? "5+0",
      rated: data.rated ?? true,
    });
    await storeA.save(match);
    return match;
  }

  async function createSkiMatchInStoreA(
    entityId: string,
    data: Partial<{
      createdAt: Date;
      resort: string;
      skillLevel: string;
    }>
  ): Promise<SkiMatch> {
    const match = new SkiMatch(entityId, {
      createdAt: data.createdAt ?? new Date(),
      resort: data.resort ?? "Aspen",
      skillLevel: data.skillLevel ?? "intermediate",
    });
    await storeA.save(match);
    return match;
  }

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

  describe("hydration from separate tables", () => {
    it("hydrates ChessMatch from chessMatchs table with correct class instance", async () => {
      const chessId = id();
      await createChessMatchInStoreA(chessId, {
        timeControl: "10+5",
        rated: false,
      });

      await storeB.query({ chessMatchs: {} });

      const chess = storeB.getById(ChessMatch, chessId);
      expect(chess).toBeInstanceOf(ChessMatch);
      expect(chess!.timeControl).toBe("10+5");
      expect(chess!.rated).toBe(false);
    });

    it("hydrates SkiMatch from skiMatchs table with correct class instance", async () => {
      const skiId = id();
      await createSkiMatchInStoreA(skiId, {
        resort: "Vail",
        skillLevel: "beginner",
      });

      await storeB.query({ skiMatchs: {} });

      const ski = storeB.getById(SkiMatch, skiId);
      expect(ski).toBeInstanceOf(SkiMatch);
      expect(ski!.resort).toBe("Vail");
      expect(ski!.skillLevel).toBe("beginner");
    });

    it("each entity type queries its own table independently", async () => {
      const chessId = id();
      const skiId = id();

      await createChessMatchInStoreA(chessId, { timeControl: "3+2" });
      await createSkiMatchInStoreA(skiId, { resort: "Whistler" });

      // Query only chessMatchs
      await storeB.query({ chessMatchs: {} });

      const chess = storeB.getById(ChessMatch, chessId);
      const ski = storeB.getById(SkiMatch, skiId);

      expect(chess).toBeInstanceOf(ChessMatch);
      expect(ski).toBeUndefined(); // Not queried yet
    });
  });

  describe("relationships with MTI types", () => {
    it("sets forward relationship (ChessMatch → User) correctly", async () => {
      const userId = id();
      const chessId = id();

      const user = await createUserInStoreA(userId, { name: "Alice" });
      const chess = await createChessMatchInStoreA(chessId, {
        timeControl: "5+0",
        rated: true,
      });
      chess.requester = user;
      await storeA.save(chess);

      await storeB.query({ chessMatchs: { requester: {} } });

      const hydratedChess = storeB.getById(ChessMatch, chessId);
      const hydratedUser = storeB.getById(User, userId);

      expect(hydratedChess!.requester).toBe(hydratedUser);
    });

    it("sets reverse relationship (User → ChessMatchs) correctly", async () => {
      const userId = id();
      const chess1Id = id();
      const chess2Id = id();

      const user = await createUserInStoreA(userId, { name: "Bob" });

      const chess1 = await createChessMatchInStoreA(chess1Id, {
        timeControl: "1+0",
      });
      chess1.requester = user;
      await storeA.save(chess1);

      const chess2 = await createChessMatchInStoreA(chess2Id, {
        timeControl: "15+10",
      });
      chess2.requester = user;
      await storeA.save(chess2);

      await storeB.query({ users: { chessMatchs: {} } });

      const hydratedUser = storeB.getById(User, userId);
      expect(hydratedUser!.chessMatchs.length).toBe(2);
      expect(hydratedUser!.chessMatchs).toContainEqual(expect.any(ChessMatch));
    });

    it("user can have both ChessMatchs and SkiMatchs (separate relationships)", async () => {
      const userId = id();
      const chessId = id();
      const skiId = id();

      const user = await createUserInStoreA(userId, { name: "Charlie" });

      const chess = await createChessMatchInStoreA(chessId, {
        timeControl: "5+3",
      });
      chess.requester = user;
      await storeA.save(chess);

      const ski = await createSkiMatchInStoreA(skiId, { resort: "Aspen" });
      ski.requester = user;
      await storeA.save(ski);

      await storeB.query({
        users: { chessMatchs: {}, skiMatchs: {} },
      });

      const hydratedUser = storeB.getById(User, userId);
      expect(hydratedUser!.chessMatchs.length).toBe(1);
      expect(hydratedUser!.skiMatchs.length).toBe(1);
      expect(hydratedUser!.chessMatchs[0]).toBeInstanceOf(ChessMatch);
      expect(hydratedUser!.skiMatchs[0]).toBeInstanceOf(SkiMatch);
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

    it("removes deleted MTI entity from identity map (ChessMatch)", async () => {
      const chessId = id();

      // Create entity
      await createChessMatchInStoreA(chessId, { timeControl: "5+0" });

      // Hydrate in store B
      await storeB.query({ chessMatchs: {} });
      expect(storeB.getById(ChessMatch, chessId)).toBeDefined();

      // Mark as deleted in DB
      await markAsDeletedInDb("chessMatchs", chessId);

      // Re-hydrate - should be removed
      await storeB.query({ chessMatchs: {} });
      expect(storeB.getById(ChessMatch, chessId)).toBeUndefined();
    });

    it("removes deleted MTI entity from identity map (SkiMatch)", async () => {
      const skiId = id();

      // Create entity
      await createSkiMatchInStoreA(skiId, { resort: "Vail" });

      // Hydrate in store B
      await storeB.query({ skiMatchs: {} });
      expect(storeB.getById(SkiMatch, skiId)).toBeDefined();

      // Mark as deleted in DB
      await markAsDeletedInDb("skiMatchs", skiId);

      // Re-hydrate - should be removed
      await storeB.query({ skiMatchs: {} });
      expect(storeB.getById(SkiMatch, skiId)).toBeUndefined();
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
      await storeB.query({ chessMatchs: { requester: {} } });
      const hydratedChess = storeB.getById(ChessMatch, chessId);
      expect(hydratedChess!.requester).toBeDefined();

      // Delete user in DB
      await markAsDeletedInDb("users", userId);

      // Re-hydrate - chess.requester should be null
      await storeB.query({ users: {} });
      expect(hydratedChess!.requester).toBeNull();
    });

    it("removes deleted ChessMatch from reverse array (user.chessMatchs)", async () => {
      const userId = id();
      const chess1Id = id();
      const chess2Id = id();

      // Create user with 2 chess matches
      const user = await createUserInStoreA(userId, { name: "Bob" });
      const chess1 = await createChessMatchInStoreA(chess1Id, { timeControl: "3+2" });
      chess1.requester = user;
      await storeA.save(chess1);

      const chess2 = await createChessMatchInStoreA(chess2Id, { timeControl: "10+5" });
      chess2.requester = user;
      await storeA.save(chess2);

      // Hydrate
      await storeB.query({ users: { chessMatchs: {} } });
      const hydratedUser = storeB.getById(User, userId);
      expect(hydratedUser!.chessMatchs.length).toBe(2);

      // Delete one chess match
      await markAsDeletedInDb("chessMatchs", chess1Id);

      // Re-hydrate - should only have 1 chess match
      await storeB.query({ chessMatchs: {} });
      expect(hydratedUser!.chessMatchs.length).toBe(1);
      expect(hydratedUser!.chessMatchs[0]!.id).toBe(chess2Id);
    });

    it("removes deleted SkiMatch from reverse array (user.skiMatchs)", async () => {
      const userId = id();
      const ski1Id = id();
      const ski2Id = id();

      // Create user with 2 ski matches
      const user = await createUserInStoreA(userId, { name: "Charlie" });
      const ski1 = await createSkiMatchInStoreA(ski1Id, { resort: "Aspen" });
      ski1.requester = user;
      await storeA.save(ski1);

      const ski2 = await createSkiMatchInStoreA(ski2Id, { resort: "Vail" });
      ski2.requester = user;
      await storeA.save(ski2);

      // Hydrate
      await storeB.query({ users: { skiMatchs: {} } });
      const hydratedUser = storeB.getById(User, userId);
      expect(hydratedUser!.skiMatchs.length).toBe(2);

      // Delete one ski match
      await markAsDeletedInDb("skiMatchs", ski1Id);

      // Re-hydrate - should only have 1 ski match
      await storeB.query({ skiMatchs: {} });
      expect(hydratedUser!.skiMatchs.length).toBe(1);
      expect(hydratedUser!.skiMatchs[0]!.id).toBe(ski2Id);
    });

    it("MTI deletions don't affect other MTI type arrays", async () => {
      const userId = id();
      const chessId = id();
      const skiId = id();

      // Create user with ChessMatch + SkiMatch
      const user = await createUserInStoreA(userId, { name: "Dave" });

      const chess = await createChessMatchInStoreA(chessId, { timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      const ski = await createSkiMatchInStoreA(skiId, { resort: "Aspen" });
      ski.requester = user;
      await storeA.save(ski);

      // Hydrate
      await storeB.query({ users: { chessMatchs: {}, skiMatchs: {} } });
      const hydratedUser = storeB.getById(User, userId);
      expect(hydratedUser!.chessMatchs.length).toBe(1);
      expect(hydratedUser!.skiMatchs.length).toBe(1);

      // Delete ChessMatch only
      await markAsDeletedInDb("chessMatchs", chessId);

      // Re-hydrate
      await storeB.query({ chessMatchs: {}, skiMatchs: {} });

      // ChessMatchs should be empty, SkiMatchs should still have 1
      expect(hydratedUser!.chessMatchs.length).toBe(0);
      expect(hydratedUser!.skiMatchs.length).toBe(1);
    });
  });

  describe("relationship removal", () => {
    it("clears forward 1:1 when set to null (chessMatch.requester = null)", async () => {
      const userId = id();
      const chessId = id();

      // Create linked entities
      const user = await createUserInStoreA(userId, { name: "Eve" });
      const chess = await createChessMatchInStoreA(chessId, { timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      // Clear the relationship
      chess.requester = null;
      await storeA.save(chess);

      // Verify in store B
      await storeB.query({ chessMatchs: { requester: {} } });
      const hydratedChess = storeB.getById(ChessMatch, chessId);
      expect(hydratedChess!.requester).toBeNull();
    });

    it("removes from reverse 1:n when forward cleared (user.chessMatchs)", async () => {
      const userId = id();
      const chessId = id();

      // Create linked entities
      const user = await createUserInStoreA(userId, { name: "Frank" });
      const chess = await createChessMatchInStoreA(chessId, { timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      // Hydrate and verify relationship
      await storeB.query({ users: { chessMatchs: {} } });
      const hydratedUser = storeB.getById(User, userId);
      expect(hydratedUser!.chessMatchs.length).toBe(1);

      // Clear relationship in store A
      chess.requester = null;
      await storeA.save(chess);

      // Re-hydrate from user side to refresh reverse relationships
      await storeB.query({ users: { chessMatchs: {} } });
      expect(hydratedUser!.chessMatchs.length).toBe(0);
    });

    it("clears forward 1:1 for SkiMatch (skiMatch.requester = null)", async () => {
      const userId = id();
      const skiId = id();

      // Create linked entities
      const user = await createUserInStoreA(userId, { name: "Grace" });
      const ski = await createSkiMatchInStoreA(skiId, { resort: "Whistler" });
      ski.requester = user;
      await storeA.save(ski);

      // Clear the relationship
      ski.requester = null;
      await storeA.save(ski);

      // Verify in store B
      await storeB.query({ skiMatchs: { requester: {} } });
      const hydratedSki = storeB.getById(SkiMatch, skiId);
      expect(hydratedSki!.requester).toBeNull();
    });

    it("removes from reverse 1:n when forward cleared (user.skiMatchs)", async () => {
      const userId = id();
      const skiId = id();

      // Create linked entities
      const user = await createUserInStoreA(userId, { name: "Henry" });
      const ski = await createSkiMatchInStoreA(skiId, { resort: "Tahoe" });
      ski.requester = user;
      await storeA.save(ski);

      // Hydrate and verify relationship
      await storeB.query({ users: { skiMatchs: {} } });
      const hydratedUser = storeB.getById(User, userId);
      expect(hydratedUser!.skiMatchs.length).toBe(1);

      // Clear relationship in store A
      ski.requester = null;
      await storeA.save(ski);

      // Re-hydrate from user side to refresh reverse relationships
      await storeB.query({ users: { skiMatchs: {} } });
      expect(hydratedUser!.skiMatchs.length).toBe(0);
    });
  });
});
