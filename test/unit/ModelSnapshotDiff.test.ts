import { describe, it, expect, beforeAll } from "vitest";
import { configureEntityMeta, Temporal } from "../../src/object-graph";
import { ModelSnapshot } from "../../src/object-graph/persistence/ModelSnapshot";
import { ModelSnapshotDiff } from "../../src/object-graph/persistence/ModelSnapshotDiff";
import schema from "../support/instant.schema";
import { User } from "../support/entities/User";
import { withTestTransaction } from "../../src/testing";

beforeAll(() => {
  configureEntityMeta(schema);
});

describe("ModelSnapshotDiff", () => {
  it("does not flag a Date scalar as changed when only the instance differs but the time is equal", () => {
    withTestTransaction(() => {
      // Two distinct Instant instances, equal time. Cross-hydration produces this
      // case: each hydrated model gets a fresh `Instant.from(iso)` even though the
      // underlying ISO string is unchanged.
      const t = "2026-05-03T12:00:00.000Z";

      const u1 = new User("u");
      Reflect.set(u1, "_updatedAt", Temporal.Instant.from(t));
      const before = new ModelSnapshot(u1);

      const u2 = new User("u");
      Reflect.set(u2, "_updatedAt", Temporal.Instant.from(t));
      const after = new ModelSnapshot(u2);

      const diff = new ModelSnapshotDiff(before, after, "users", false);

      expect(diff.scalars.has("updatedAt")).toBe(false);
    });
  });

  it("flags a Date scalar as changed when the time differs", () => {
    withTestTransaction(() => {
      const u1 = new User("u");
      Reflect.set(u1, "_updatedAt", Temporal.Instant.from("2026-05-03T12:00:00.000Z"));
      const before = new ModelSnapshot(u1);

      const u2 = new User("u");
      Reflect.set(u2, "_updatedAt", Temporal.Instant.from("2026-05-03T12:00:01.000Z"));
      const after = new ModelSnapshot(u2);

      const diff = new ModelSnapshotDiff(before, after, "users", false);

      expect(diff.scalars.has("updatedAt")).toBe(true);
    });
  });
});
