import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { reaction } from "mobx";
import {
  setupTestDatabase,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { User } from "../entities/User";
import { Post } from "../entities/Post";

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

function trapArrayScans(): { stop(): number } {
  const originals = new Map<ScanMethod, Function>();
  let calls = 0;
  for (const name of SCAN_METHODS) {
    const orig = (Array.prototype as any)[name];
    if (typeof orig !== "function") continue;
    originals.set(name, orig);
    (Array.prototype as any)[name] = function (...args: unknown[]) {
      calls++;
      return orig.apply(this, args);
    };
  }
  return {
    stop(): number {
      for (const [name, orig] of originals) {
        (Array.prototype as any)[name] = orig;
      }
      return calls;
    },
  };
}

describe("performance", () => {
  let db: TestInstantDBClient;

  beforeEach(() => {
    db = setupTestDatabase();
  });

  afterEach(() => {});

  it("hydrating a user with many posts does not scan arrays per row", async () => {
    const N = 20;

    const seed = new RootStore({ db });
    await seed.transaction(() => {
      const u = new User("Owner");
      for (let i = 0; i < N; i++) {
        const p = new Post(`Post ${i}`);
        p.author = u;
      }
    });

    const fresh = new RootStore({ db });

    const trap = trapArrayScans();
    let calls = 0;
    try {
      await fresh.queryAll();
    } finally {
      calls = trap.stop();
    }

    expect(calls).toBeLessThan(N * 4 + 100);
  });

  it("hydrating posts under a watched user fires reactions at most once per batch", async () => {
    const N = 20;

    let userId = "";
    const seed = new RootStore({ db });
    await seed.transaction(() => {
      const u = new User("Owner");
      userId = u.id;
      for (let i = 0; i < N; i++) {
        const p = new Post(`Post ${i}`);
        p.author = u;
      }
    });

    const fresh = new RootStore({ db });
    await fresh.queryModel(User);
    const user = fresh.getById(User, userId)!;
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

    let userId = "";
    const postIds: string[] = [];
    const seed = new RootStore({ db });
    await seed.transaction(() => {
      const u = new User("Owner");
      userId = u.id;
      for (let i = 0; i < N; i++) {
        const p = new Post(`Post ${i}`);
        p.author = u;
        postIds.push(p.id);
      }
    });

    const fresh = new RootStore({ db });
    await fresh.queryAll();

    const targetPost = fresh.getById(Post, postIds[0])!;
    const untouchedPost = fresh.getById(Post, postIds[1])!;

    let targetFires = 0;
    let untouchedFires = 0;
    const d1 = reaction(() => targetPost.title, () => { targetFires++; });
    const d2 = reaction(() => untouchedPost.title, () => { untouchedFires++; });

    const remote = new RootStore({ db });
    await remote.queryAll();
    await remote.transaction(() => {
      const remotePost = remote.getById(Post, postIds[0])!;
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
    const seed = new RootStore({ db });
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

    const fresh = new RootStore({ db });
    await fresh.queryAll();

    const userA = fresh.getById(User, userAId)!;
    const userB = fresh.getById(User, userBId)!;
    const untouchedPost = fresh.getById(Post, postIds[1])!;

    let aLengthFires = 0;
    let bLengthFires = 0;
    let untouchedTitleFires = 0;
    const d1 = reaction(() => userA.posts.length, () => { aLengthFires++; });
    const d2 = reaction(() => userB.posts.length, () => { bLengthFires++; });
    const d3 = reaction(() => untouchedPost.title, () => { untouchedTitleFires++; });

    const remote = new RootStore({ db });
    await remote.queryAll();
    await remote.transaction(() => {
      const remotePost = remote.getById(Post, postIds[0])!;
      const remoteB = remote.getById(User, userBId)!;
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
