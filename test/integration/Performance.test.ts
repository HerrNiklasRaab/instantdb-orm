import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { reaction } from "mobx";
import {
  assertDefined,
  firstOrFail,
  setupTestDatabase,
  type TestInstantDBClient,
} from "./support/instantdb-test-utils";
import { RootStore } from "../../src/object-graph/store/RootStore";
import type { AppSchema } from "../support/instant.schema";
import { User } from "../support/entities/User";
import { Post } from "../support/entities/Post";

const SCAN_METHODS = [
  "includes",
  "indexOf",
  "lastIndexOf",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "some",
  "every",
  "filter",
] as const;

type ScanMethod = (typeof SCAN_METHODS)[number];
type ArrayScanFn = (this: unknown[], ...args: unknown[]) => unknown;
type ScanPrototype = Record<ScanMethod, ArrayScanFn>;

function isScanPrototype(proto: object): proto is ScanPrototype {
  return SCAN_METHODS.every(
    (name) => typeof Reflect.get(proto, name) === "function"
  );
}

function trapArrayScans(): { stop(): number } {
  const proto: object = Array.prototype;
  if (!isScanPrototype(proto)) {
    throw new Error("Array.prototype is missing expected scan methods");
  }
  const originals = new Map<ScanMethod, ArrayScanFn>();
  let calls = 0;
  for (const name of SCAN_METHODS) {
    const orig = proto[name];
    originals.set(name, orig);
    proto[name] = function (this: unknown[], ...args: unknown[]): unknown {
      calls++;
      return orig.apply(this, args);
    };
  }
  return {
    stop(): number {
      for (const [name, orig] of originals) {
        proto[name] = orig;
      }
      return calls;
    },
  };
}

interface RootStoreInternals {
  hydrator: { hydrateMany: (entity: string, rows: unknown[], getMap: unknown) => unknown };
  getIdentityMapByName: (entity: string) => unknown;
}

function isRootStoreInternals(value: object): value is object & RootStoreInternals {
  const hydrator: unknown = Reflect.get(value, "hydrator");
  const getMap: unknown = Reflect.get(value, "getIdentityMapByName");
  if (typeof hydrator !== "object" || hydrator === null) return false;
  return (
    typeof Reflect.get(hydrator, "hydrateMany") === "function" &&
    typeof getMap === "function"
  );
}

function openInternals(store: RootStore<AppSchema>): RootStoreInternals {
  if (!isRootStoreInternals(store)) {
    throw new Error("RootStore is missing expected internal members");
  }
  return store;
}

describe("performance", () => {
  let db: TestInstantDBClient;

  beforeEach(() => {
    db = setupTestDatabase();
  });

  afterEach(() => {});

  it("hydrating a user with many posts does not scan arrays per row", () => {
    const N = 20;

    const store = new RootStore<AppSchema>({ db });
    const internals = openInternals(store);
    const getMap = internals.getIdentityMapByName.bind(internals);

    const now = new Date().toISOString();
    const userId = "perf-user";
    const nestedPosts = Array.from({ length: N }, (_, i) => ({
      id: `perf-post-${i}`,
      title: `Post ${i}`,
      content: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      author: [{ id: userId }],
    }));
    const rawUsers = [{
      id: userId,
      name: "Owner",
      testDate: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      posts: nestedPosts,
    }];

    const rawPostsForResync = nestedPosts.map((p) => ({ ...p }));

    const trap = trapArrayScans();
    let calls = 0;
    try {
      internals.hydrator.hydrateMany("users", rawUsers, getMap);
      internals.hydrator.hydrateMany("posts", rawPostsForResync, getMap);
    } finally {
      calls = trap.stop();
    }

    expect(calls).toBeLessThan(N * 4 + 50);
  });

  it("hydrating posts under a watched user fires reactions at most once per batch", async () => {
    const N = 20;

    let userId = "";
    const seed = new RootStore<AppSchema>({ db });
    await seed.transaction(() => {
      const u = new User("Owner");
      userId = u.id;
      for (let i = 0; i < N; i++) {
        const p = new Post(`Post ${i}`);
        p.author = u;
      }
    });

    const fresh = new RootStore<AppSchema>({ db });
    await fresh.queryModel(User);
    const user = fresh.getById(User, userId);
    assertDefined(user);
    expect(user.posts.length).toBe(0);

    let fires = 0;
    const disposer = reaction(
      () => user.posts.length,
      () => {
        fires++;
      }
    );

    try {
      await fresh.queryModel(Post);
    } finally {
      disposer();
    }

    expect(user.posts.length).toBe(N);
    expect(fires).toBe(1);
  });

  it("a remote single-field update fires only the changed row's reactions", async () => {
    const N = 20;

    const postIds: string[] = [];
    const seed = new RootStore<AppSchema>({ db });
    await seed.transaction(() => {
      const u = new User("Owner");
      for (let i = 0; i < N; i++) {
        const p = new Post(`Post ${i}`);
        p.author = u;
        postIds.push(p.id);
      }
    });

    const fresh = new RootStore<AppSchema>({ db });
    await fresh.queryAll();

    const targetId = firstOrFail(postIds);
    const untouchedId = firstOrFail(postIds.slice(1));
    const targetPost = fresh.getById(Post, targetId);
    const untouchedPost = fresh.getById(Post, untouchedId);
    assertDefined(targetPost);
    assertDefined(untouchedPost);

    let targetFires = 0;
    let untouchedFires = 0;
    const d1 = reaction(() => targetPost.title, () => { targetFires++; });
    const d2 = reaction(() => untouchedPost.title, () => { untouchedFires++; });

    const remote = new RootStore<AppSchema>({ db });
    await remote.queryAll();
    await remote.transaction(() => {
      const remotePost = remote.getById(Post, targetId);
      assertDefined(remotePost);
      remotePost.title = "Updated title";
    });

    try {
      await fresh.queryAll();
    } finally {
      d1();
      d2();
    }

    expect(targetPost.title).toBe("Updated title");
    expect(targetFires).toBe(1);
    expect(untouchedFires).toBe(0);
  });

  it("a remote to-many membership change fires only the affected sides", async () => {
    const N = 20;

    let userAId = "";
    let userBId = "";
    const postIds: string[] = [];
    const seed = new RootStore<AppSchema>({ db });
    await seed.transaction(() => {
      const a = new User("Alice");
      const b = new User("Bob");
      userAId = a.id;
      userBId = b.id;
      for (let i = 0; i < N; i++) {
        const p = new Post(`Post ${i}`);
        p.author = a;
        postIds.push(p.id);
      }
    });

    const fresh = new RootStore<AppSchema>({ db });
    await fresh.queryAll();

    const firstPostId = firstOrFail(postIds);
    const untouchedPostId = firstOrFail(postIds.slice(1));
    const userA = fresh.getById(User, userAId);
    const userB = fresh.getById(User, userBId);
    const untouchedPost = fresh.getById(Post, untouchedPostId);
    assertDefined(userA);
    assertDefined(userB);
    assertDefined(untouchedPost);

    let aLengthFires = 0;
    let bLengthFires = 0;
    let untouchedTitleFires = 0;
    const d1 = reaction(() => userA.posts.length, () => { aLengthFires++; });
    const d2 = reaction(() => userB.posts.length, () => { bLengthFires++; });
    const d3 = reaction(() => untouchedPost.title, () => { untouchedTitleFires++; });

    const remote = new RootStore<AppSchema>({ db });
    await remote.queryAll();
    await remote.transaction(() => {
      const remotePost = remote.getById(Post, firstPostId);
      const remoteB = remote.getById(User, userBId);
      assertDefined(remotePost);
      assertDefined(remoteB);
      remotePost.author = remoteB;
    });

    try {
      await fresh.queryAll();
    } finally {
      d1();
      d2();
      d3();
    }

    expect(userA.posts.length).toBe(N - 1);
    expect(userB.posts.length).toBe(1);
    expect(aLengthFires).toBe(1);
    expect(bLengthFires).toBe(1);
    expect(untouchedTitleFires).toBe(0);
  });
});
