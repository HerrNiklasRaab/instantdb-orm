import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import {
  setupTestDatabase,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";
import { User } from "../entities/User";
import { ChessRequest } from "../entities/ChessRequest";
import { SkiRequest } from "../entities/SkiRequest";

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
    }> = {}
  ): Promise<User> {
    const user = new User(data.name ?? "Test User");
    await storeA.save(user);
    return user;
  }

  // Helper to create ChessRequest through Store A
  async function createChessRequestInStoreA(
    data: Partial<{
      timeControl: string;
      rated: boolean;
    }> = {}
  ): Promise<ChessRequest> {
    const request = new ChessRequest(
      data.timeControl ?? "5+0",
      data.rated ?? true
    );
    await storeA.save(request);
    return request;
  }

  // Helper to create SkiRequest through Store A
  async function createSkiRequestInStoreA(
    data: Partial<{
      resort: string;
      skillLevel: string;
    }> = {}
  ): Promise<SkiRequest> {
    const request = new SkiRequest(
      data.resort ?? "Aspen",
      data.skillLevel ?? "intermediate"
    );
    await storeA.save(request);
    return request;
  }

  describe("hydration with type discriminator", () => {
    it("hydrates mixed types from same table with correct class instances", async () => {
      // Store A creates both types
      const chessA = await createChessRequestInStoreA({
        timeControl: "10+5",
        rated: false,
      });
      const skiA = await createSkiRequestInStoreA({
        resort: "Vail",
        skillLevel: "beginner",
      });

      // Store B hydrates all requests
      await storeB.query({ requests: {} });

      const chess = storeB.getById(ChessRequest, chessA.id);
      const ski = storeB.getById(SkiRequest, skiA.id);

      // Each should be the correct subclass instance
      expect(chess).toBeInstanceOf(ChessRequest);
      expect(chess!.modelType).toBe("chess");
      expect(chess!.timeControl).toBe("10+5");

      expect(ski).toBeInstanceOf(SkiRequest);
      expect(ski!.modelType).toBe("ski");
      expect(ski!.resort).toBe("Vail");
    });
  });

  describe("relationships with inherited types", () => {
    it("sets forward relationship (subtype → User) correctly", async () => {
      // Create user and chess request with requester link
      const user = await createUserInStoreA({ name: "Alice" });
      const chess = await createChessRequestInStoreA({
        timeControl: "5+0",
        rated: true,
      });
      chess.requester = user;
      await storeA.save(chess);

      // Store B hydrates
      await storeB.query({ requests: { requester: {} } });

      const hydratedChess = storeB.getById(ChessRequest, chess.id);
      const hydratedUser = storeB.getById(User, user.id);

      expect(hydratedChess!.requester).toBe(hydratedUser);
    });

    it("sets reverse relationship (User → subtypes) correctly", async () => {
      // Create user with two different request types
      const user = await createUserInStoreA({ name: "Bob" });

      const chess = await createChessRequestInStoreA({
        timeControl: "3+2",
        rated: false,
      });
      chess.requester = user;
      await storeA.save(chess);

      const ski = await createSkiRequestInStoreA({
        resort: "Aspen",
        skillLevel: "advanced",
      });
      ski.requester = user;
      await storeA.save(ski);

      // Store B hydrates
      await storeB.query({ users: { requests: {} } });

      const hydratedUser = storeB.getById(User, user.id);

      // User.requests should contain both subtypes
      expect(hydratedUser!.requests.length).toBe(2);
      expect(hydratedUser!.requests).toContainEqual(
        expect.any(ChessRequest)
      );
      expect(hydratedUser!.requests).toContainEqual(
        expect.any(SkiRequest)
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
      const chess = await createChessRequestInStoreA({ timeControl: "5+0" });

      // Hydrate in store B
      await storeB.query({ requests: {} });
      expect(storeB.getById(ChessRequest, chess.id)).toBeDefined();

      // Mark as deleted in DB (simulating deletion from another device)
      await markAsDeletedInDb("requests", chess.id);

      // Re-hydrate - should be removed
      await storeB.query({ requests: {} });
      expect(storeB.getById(ChessRequest, chess.id)).toBeUndefined();
    });

    it("sets forward relationship to null when User is deleted (request.requester → null)", async () => {
      // Create user and linked request
      const user = await createUserInStoreA({ name: "Alice" });
      const chess = await createChessRequestInStoreA({ timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      // Hydrate in store B
      await storeB.query({ requests: { requester: {} } });
      const hydratedChess = storeB.getById(ChessRequest, chess.id);
      expect(hydratedChess!.requester).toBeDefined();

      // Delete user in DB
      await markAsDeletedInDb("users", user.id);

      // Re-hydrate - chess.requester should be null
      await storeB.query({ users: {} });
      expect(hydratedChess!.requester).toBeNull();
    });

    it("removes deleted STI entity from reverse array (user.requests)", async () => {
      // Create user with 2 requests
      const user = await createUserInStoreA({ name: "Bob" });
      const chess1 = await createChessRequestInStoreA({ timeControl: "3+2" });
      chess1.requester = user;
      await storeA.save(chess1);

      const chess2 = await createChessRequestInStoreA({ timeControl: "10+5" });
      chess2.requester = user;
      await storeA.save(chess2);

      // Hydrate
      await storeB.query({ users: { requests: {} } });
      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser!.requests.length).toBe(2);

      // Delete one request
      await markAsDeletedInDb("requests", chess1.id);

      // Re-hydrate - should only have 1 request
      await storeB.query({ requests: {} });
      expect(hydratedUser!.requests.length).toBe(1);
      expect(hydratedUser!.requests[0]!.id).toBe(chess2.id);
    });

    it("handles mixed STI types in reverse array cleanup", async () => {
      // Create user with ChessRequest + SkiRequest
      const user = await createUserInStoreA({ name: "Charlie" });

      const chess = await createChessRequestInStoreA({ timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      const ski = await createSkiRequestInStoreA({ resort: "Aspen" });
      ski.requester = user;
      await storeA.save(ski);

      // Hydrate
      await storeB.query({ users: { requests: {} } });
      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser!.requests.length).toBe(2);

      // Delete ChessRequest
      await markAsDeletedInDb("requests", chess.id);

      // Re-hydrate
      await storeB.query({ requests: {} });
      expect(hydratedUser!.requests.length).toBe(1);
      expect(hydratedUser!.requests[0]).toBeInstanceOf(SkiRequest);
    });
  });

  describe("relationship removal", () => {
    it("clears forward 1:1 when set to null (request.requester = null)", async () => {
      // Create linked entities
      const user = await createUserInStoreA({ name: "Dave" });
      const chess = await createChessRequestInStoreA({ timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      // Clear the relationship
      chess.requester = null;
      await storeA.save(chess);

      // Verify in store B
      await storeB.query({ requests: { requester: {} } });
      const hydratedChess = storeB.getById(ChessRequest, chess.id);
      expect(hydratedChess!.requester).toBeNull();
    });

    it("removes from reverse 1:n when forward cleared", async () => {
      // Create linked entities
      const user = await createUserInStoreA({ name: "Eve" });
      const chess = await createChessRequestInStoreA({ timeControl: "5+0" });
      chess.requester = user;
      await storeA.save(chess);

      // Hydrate and verify relationship
      await storeB.query({ users: { requests: {} } });
      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser!.requests.length).toBe(1);

      // Clear relationship in store A
      chess.requester = null;
      await storeA.save(chess);

      // Re-hydrate from user side to refresh reverse relationships
      await storeB.query({ users: { requests: {} } });
      expect(hydratedUser!.requests.length).toBe(0);
    });
  });
});
