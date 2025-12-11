import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import {
  setupTestDatabase,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";
import { User } from "../entities/User";
import { Match } from "../entities/Match";
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
    data: Partial<{
      timeControl: string;
      rated: boolean;
    }> = {}
  ): Promise<ChessMatch> {
    const match = new ChessMatch(
      data.timeControl ?? "5+0",
      data.rated ?? true
    );
    await storeA.save(match);
    return match;
  }

  async function createSkiMatchInStoreA(
    data: Partial<{
      resort: string;
      skillLevel: string;
    }> = {}
  ): Promise<SkiMatch> {
    const match = new SkiMatch(
      data.resort ?? "Aspen",
      data.skillLevel ?? "intermediate"
    );
    await storeA.save(match);
    return match;
  }

  async function createUserInStoreA(
    data: Partial<{
      name: string;
    }> = {}
  ): Promise<User> {
    const user = new User(data.name ?? "Test User");
    await storeA.save(user);
    return user;
  }

  describe("hydration from separate tables", () => {
    it("hydrates ChessMatch from chessMatchs table with correct class instance", async () => {
      const chessA = await createChessMatchInStoreA({
        timeControl: "10+5",
        rated: false,
      });

      await storeB.query({ chessMatchs: {} });

      const chess = storeB.getById(ChessMatch, chessA.id);
      expect(chess).toBeInstanceOf(ChessMatch);
      expect(chess!.timeControl).toBe("10+5");
      expect(chess!.rated).toBe(false);
    });

    it("hydrates SkiMatch from skiMatchs table with correct class instance", async () => {
      const skiA = await createSkiMatchInStoreA({
        resort: "Vail",
        skillLevel: "beginner",
      });

      await storeB.query({ skiMatchs: {} });

      const ski = storeB.getById(SkiMatch, skiA.id);
      expect(ski).toBeInstanceOf(SkiMatch);
      expect(ski!.resort).toBe("Vail");
      expect(ski!.skillLevel).toBe("beginner");
    });

    it("each entity type queries its own table independently", async () => {
      const chessA = await createChessMatchInStoreA({ timeControl: "3+2" });
      const skiA = await createSkiMatchInStoreA({ resort: "Whistler" });

      // Query only chessMatchs
      await storeB.query({ chessMatchs: {} });

      const chess = storeB.getById(ChessMatch, chessA.id);
      const ski = storeB.getById(SkiMatch, skiA.id);

      expect(chess).toBeInstanceOf(ChessMatch);
      expect(ski).toBeUndefined(); // Not queried yet
    });
  });

  describe("relationships with MTI types", () => {
    it("sets forward relationship (ChessMatch → User) correctly", async () => {
      const user = await createUserInStoreA({ name: "Alice" });
      const chess = await createChessMatchInStoreA({
        timeControl: "5+0",
        rated: true,
      });
      chess.requester = user;
      await storeA.save(chess);

      await storeB.query({ chessMatchs: { requester: {} } });

      const hydratedChess = storeB.getById(ChessMatch, chess.id);
      const hydratedUser = storeB.getById(User, user.id);

      expect(hydratedChess!.requester).toBe(hydratedUser);
    });

    it("sets reverse relationship (User → ChessMatchs) correctly", async () => {
      const user = await createUserInStoreA({ name: "Bob" });

      const chess1 = await createChessMatchInStoreA({
        timeControl: "1+0",
      });
      chess1.requester = user;
      await storeA.save(chess1);

      const chess2 = await createChessMatchInStoreA({
        timeControl: "15+10",
      });
      chess2.requester = user;
      await storeA.save(chess2);

      await storeB.query({ users: { chessMatchs: {} } });

      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser!.chessMatchs.length).toBe(2);
      expect(hydratedUser!.chessMatchs).toContainEqual(expect.any(ChessMatch));
    });

    it("user can have both ChessMatchs and SkiMatchs (separate relationships)", async () => {
      const user = await createUserInStoreA({ name: "Charlie" });

      const chess = await createChessMatchInStoreA({
        timeControl: "5+3",
      });
      chess.requester = user;
      await storeA.save(chess);

      const ski = await createSkiMatchInStoreA({ resort: "Aspen" });
      ski.requester = user;
      await storeA.save(ski);

      await storeB.query({
        users: { chessMatchs: {}, skiMatchs: {} },
      });

      const hydratedUser = storeB.getById(User, user.id);
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
      // Create entity
      const chess = await createChessMatchInStoreA({ timeControl: "5+0" });

      // Hydrate in store B
      await storeB.query({ chessMatchs: {} });
      expect(storeB.getById(ChessMatch, chess.id)).toBeDefined();

      // Mark as deleted in DB
      await markAsDeletedInDb("chessMatchs", chess.id);

      // Re-hydrate - should be removed
      await storeB.query({ chessMatchs: {} });
      expect(storeB.getById(ChessMatch, chess.id)).toBeUndefined();
    });

    it("removes deleted MTI entity from identity map (SkiMatch)", async () => {
      // Create entity
      const ski = await createSkiMatchInStoreA({ resort: "Vail" });

      // Hydrate in store B
      await storeB.query({ skiMatchs: {} });
      expect(storeB.getById(SkiMatch, ski.id)).toBeDefined();

      // Mark as deleted in DB
      await markAsDeletedInDb("skiMatchs", ski.id);

      // Re-hydrate - should be removed
      await storeB.query({ skiMatchs: {} });
      expect(storeB.getById(SkiMatch, ski.id)).toBeUndefined();
    });

    it("sets forward relationship to null when User is deleted (match.requester → null)", async () => {
      // Create user and linked match
      const user = await createUserInStoreA({ name: "Alice" });
      const chess = await createChessMatchInStoreA({ timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      // Hydrate in store B
      await storeB.query({ chessMatchs: { requester: {} } });
      const hydratedChess = storeB.getById(ChessMatch, chess.id);
      expect(hydratedChess!.requester).toBeDefined();

      // Delete user in DB
      await markAsDeletedInDb("users", user.id);

      // Re-hydrate - chess.requester should be null
      await storeB.query({ users: {} });
      expect(hydratedChess!.requester).toBeNull();
    });

    it("removes deleted ChessMatch from reverse array (user.chessMatchs)", async () => {
      // Create user with 2 chess matches
      const user = await createUserInStoreA({ name: "Bob" });
      const chess1 = await createChessMatchInStoreA({ timeControl: "3+2" });
      chess1.requester = user;
      await storeA.save(chess1);

      const chess2 = await createChessMatchInStoreA({ timeControl: "10+5" });
      chess2.requester = user;
      await storeA.save(chess2);

      // Hydrate
      await storeB.query({ users: { chessMatchs: {} } });
      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser!.chessMatchs.length).toBe(2);

      // Delete one chess match
      await markAsDeletedInDb("chessMatchs", chess1.id);

      // Re-hydrate - should only have 1 chess match
      await storeB.query({ chessMatchs: {} });
      expect(hydratedUser!.chessMatchs.length).toBe(1);
      expect(hydratedUser!.chessMatchs[0]!.id).toBe(chess2.id);
    });

    it("removes deleted SkiMatch from reverse array (user.skiMatchs)", async () => {
      // Create user with 2 ski matches
      const user = await createUserInStoreA({ name: "Charlie" });
      const ski1 = await createSkiMatchInStoreA({ resort: "Aspen" });
      ski1.requester = user;
      await storeA.save(ski1);

      const ski2 = await createSkiMatchInStoreA({ resort: "Vail" });
      ski2.requester = user;
      await storeA.save(ski2);

      // Hydrate
      await storeB.query({ users: { skiMatchs: {} } });
      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser!.skiMatchs.length).toBe(2);

      // Delete one ski match
      await markAsDeletedInDb("skiMatchs", ski1.id);

      // Re-hydrate - should only have 1 ski match
      await storeB.query({ skiMatchs: {} });
      expect(hydratedUser!.skiMatchs.length).toBe(1);
      expect(hydratedUser!.skiMatchs[0]!.id).toBe(ski2.id);
    });

    it("MTI deletions don't affect other MTI type arrays", async () => {
      // Create user with ChessMatch + SkiMatch
      const user = await createUserInStoreA({ name: "Dave" });

      const chess = await createChessMatchInStoreA({ timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      const ski = await createSkiMatchInStoreA({ resort: "Aspen" });
      ski.requester = user;
      await storeA.save(ski);

      // Hydrate
      await storeB.query({ users: { chessMatchs: {}, skiMatchs: {} } });
      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser!.chessMatchs.length).toBe(1);
      expect(hydratedUser!.skiMatchs.length).toBe(1);

      // Delete ChessMatch only
      await markAsDeletedInDb("chessMatchs", chess.id);

      // Re-hydrate
      await storeB.query({ chessMatchs: {}, skiMatchs: {} });

      // ChessMatchs should be empty, SkiMatchs should still have 1
      expect(hydratedUser!.chessMatchs.length).toBe(0);
      expect(hydratedUser!.skiMatchs.length).toBe(1);
    });
  });

  describe("relationship removal", () => {
    it("clears forward 1:1 when set to null (chessMatch.requester = null)", async () => {
      // Create linked entities
      const user = await createUserInStoreA({ name: "Eve" });
      const chess = await createChessMatchInStoreA({ timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      // Clear the relationship
      chess.requester = null;
      await storeA.save(chess);

      // Verify in store B
      await storeB.query({ chessMatchs: { requester: {} } });
      const hydratedChess = storeB.getById(ChessMatch, chess.id);
      expect(hydratedChess!.requester).toBeNull();
    });

    it("removes from reverse 1:n when forward cleared (user.chessMatchs)", async () => {
      // Create linked entities
      const user = await createUserInStoreA({ name: "Frank" });
      const chess = await createChessMatchInStoreA({ timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      // Hydrate and verify relationship
      await storeB.query({ users: { chessMatchs: {} } });
      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser!.chessMatchs.length).toBe(1);

      // Clear relationship in store A
      chess.requester = null;
      await storeA.save(chess);

      // Re-hydrate from user side to refresh reverse relationships
      await storeB.query({ users: { chessMatchs: {} } });
      expect(hydratedUser!.chessMatchs.length).toBe(0);
    });

    it("clears forward 1:1 for SkiMatch (skiMatch.requester = null)", async () => {
      // Create linked entities
      const user = await createUserInStoreA({ name: "Grace" });
      const ski = await createSkiMatchInStoreA({ resort: "Whistler" });
      ski.requester = user;
      await storeA.save(ski);

      // Clear the relationship
      ski.requester = null;
      await storeA.save(ski);

      // Verify in store B
      await storeB.query({ skiMatchs: { requester: {} } });
      const hydratedSki = storeB.getById(SkiMatch, ski.id);
      expect(hydratedSki!.requester).toBeNull();
    });

    it("removes from reverse 1:n when forward cleared (user.skiMatchs)", async () => {
      // Create linked entities
      const user = await createUserInStoreA({ name: "Henry" });
      const ski = await createSkiMatchInStoreA({ resort: "Tahoe" });
      ski.requester = user;
      await storeA.save(ski);

      // Hydrate and verify relationship
      await storeB.query({ users: { skiMatchs: {} } });
      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser!.skiMatchs.length).toBe(1);

      // Clear relationship in store A
      ski.requester = null;
      await storeA.save(ski);

      // Re-hydrate from user side to refresh reverse relationships
      await storeB.query({ users: { skiMatchs: {} } });
      expect(hydratedUser!.skiMatchs.length).toBe(0);
    });
  });

  describe("polymorphic getAll", () => {
    it("should return all subclass instances when called with base class", async () => {
      await createChessMatchInStoreA();
      await createSkiMatchInStoreA();

      await storeB.query({ chessMatchs: {}, skiMatchs: {} });

      const allMatches = storeB.getAll(Match);

      expect(allMatches.length).toBeGreaterThanOrEqual(2);
      expect(allMatches).toContainEqual(expect.any(ChessMatch));
      expect(allMatches).toContainEqual(expect.any(SkiMatch));
    });

    it("should still return only specific subclass when called with concrete class", async () => {
      await createChessMatchInStoreA();
      await createSkiMatchInStoreA();

      await storeB.query({ chessMatchs: {}, skiMatchs: {} });

      const chessMatches = storeB.getAll(ChessMatch);
      const skiMatches = storeB.getAll(SkiMatch);

      expect(chessMatches.length).toBeGreaterThanOrEqual(1);
      expect(skiMatches.length).toBeGreaterThanOrEqual(1);
      expect(chessMatches.every((m) => m instanceof ChessMatch)).toBe(true);
      expect(skiMatches.every((m) => m instanceof SkiMatch)).toBe(true);
    });
  });
});
