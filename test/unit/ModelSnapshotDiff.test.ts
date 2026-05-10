import { describe, it, expect, beforeAll } from "vitest";
import { configureEntityMeta } from "../../src/object-graph";
import { ModelSnapshot } from "../../src/object-graph/persistence/ModelSnapshot";
import { ModelSnapshotDiff } from "../../src/object-graph/persistence/ModelSnapshotDiff";
import schema from "../instant.schema";
import { User } from "../entities/User";
import { withTestTransaction } from "../../src/testing";

beforeAll(() => {
  configureEntityMeta(schema as Parameters<typeof configureEntityMeta>[0]);
});

describe("ModelSnapshotDiff", () => {
  it("does not flag a Date scalar as changed when only the instance differs but the time is equal", () => {
    withTestTransaction(() => {
      // Two distinct Date instances, equal time. Cross-hydration produces this case:
      // each hydrated model gets a fresh `new Date(iso)` even though the underlying
      // ISO string is unchanged.
      const t = "2026-05-03T12:00:00.000Z";

      const u1 = new User("u");
      (u1 as unknown as { _updatedAt: Date })._updatedAt = new Date(t);
      const before = new ModelSnapshot(u1, false);

      const u2 = new User("u");
      (u2 as unknown as { _updatedAt: Date })._updatedAt = new Date(t);
      const after = new ModelSnapshot(u2, false);

      const diff = new ModelSnapshotDiff(before, after, "users", false);

      expect(diff.scalars.has("updatedAt")).toBe(false);
    });
  });

  it("flags a Date scalar as changed when the time differs", () => {
    withTestTransaction(() => {
      const u1 = new User("u");
      (u1 as unknown as { _updatedAt: Date })._updatedAt = new Date("2026-05-03T12:00:00.000Z");
      const before = new ModelSnapshot(u1, false);

      const u2 = new User("u");
      (u2 as unknown as { _updatedAt: Date })._updatedAt = new Date("2026-05-03T12:00:01.000Z");
      const after = new ModelSnapshot(u2, false);

      const diff = new ModelSnapshotDiff(before, after, "users", false);

      expect(diff.scalars.has("updatedAt")).toBe(true);
    });
  });
});
