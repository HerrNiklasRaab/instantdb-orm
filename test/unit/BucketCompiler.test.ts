import { describe, expect, it } from "vitest";
import { BucketScheme, type BucketRule } from "../../src/buckets/BucketScheme";
import { schema } from "../support/zenstack/buckets/schema";

function compiled(): BucketScheme {
  return BucketScheme.compile(schema);
}

function rules(model: string): readonly BucketRule[] {
  return compiled().of(model).rules;
}

const byTeamMembership = { model: "teamMembers", identityColumn: "userId", keyColumn: "teamId" };
const ownerKey = { kind: "column", column: "ownerId", authField: "id" } as const;

function globalReason(model: string): string | null {
  const [rule, ...rest] = rules(model);
  expect(rest).toEqual([]);
  expect(rule?.kind).toBe("global");
  return rule?.kind === "global" ? rule.reason : null;
}

describe("BucketScheme.compile", () => {
  describe("row-local rules", () => {
    it("files a public model under one global bucket", () => {
      expect(rules("publicRows")).toEqual([{ kind: "global", reason: null }]);
      expect(compiled().of("publicRows").dependencies).toEqual([]);
    });

    it("keys an ownership rule on the compared column", () => {
      expect(rules("ownedRows")).toEqual([{ kind: "column", column: "ownerId", authField: "id" }]);
      expect(compiled().of("ownedRows").dependencies).toEqual([]);
    });

    it("keys two auth terms under && as one tuple", () => {
      expect(rules("pairedRows")).toEqual([{
        kind: "tuple",
        parts: [{ column: "ownerId", authField: "id" }, { column: "teamId", authField: "teamId" }],
      }]);
    });

    it("drops a row filter joined by && and keeps the key", () => {
      expect(rules("filteredRows")).toEqual([{ kind: "column", column: "ownerId", authField: "id" }]);
    });
  });

  describe("relation rules", () => {
    it("keys a collection predicate on the model's own id and holds it through the member rows", () => {
      expect(rules("teams")).toEqual([{ kind: "relation", column: "id", parameter: byTeamMembership }]);
      expect(compiled().of("teams").dependencies).toEqual(["teamMembers"]);
    });

    it("keys a one-hop collection predicate on the foreign key", () => {
      expect(rules("teamPosts")).toEqual([{ kind: "relation", column: "teamId", parameter: byTeamMembership }]);
      expect(compiled().of("teamPosts").dependencies).toEqual(["teamMembers"]);
    });

    it("keys a one-hop to-one comparison on the foreign key and holds it through the related rows", () => {
      expect(rules("roomPosts")).toEqual([{
        kind: "relation",
        column: "roomId",
        parameter: { model: "hostedRooms", identityColumn: "hostId", keyColumn: "id" },
      }]);
      expect(compiled().of("roomPosts").dependencies).toEqual(["hostedRooms"]);
    });

    it("leaves the member rows themselves keyed by their user column", () => {
      expect(rules("teamMembers")).toEqual([{ kind: "column", column: "userId", authField: "id" }]);
    });
  });

  describe("unions", () => {
    it("compiles || to one rule per branch", () => {
      expect(rules("eitherRows")).toEqual([
        { kind: "column", column: "ownerId", authField: "id" },
        { kind: "column", column: "editorId", authField: "id" },
      ]);
    });

    it("treats several read rules on one model as a union", () => {
      expect(rules("splitRules")).toEqual(rules("eitherRows"));
    });
  });

  describe("what does not compile", () => {
    it("falls back to global for != and says why", () => {
      const [rule] = rules("unequalRows");
      expect(rule?.kind).toBe("global");
      expect(rule?.kind === "global" && rule.reason).toContain("!=");
    });

    it("falls back to global for an inequality against auth() and says why", () => {
      const [rule] = rules("rankedRows");
      expect(rule?.kind).toBe("global");
      expect(rule?.kind === "global" && rule.reason).toContain(">");
    });

    it("falls back to global for a path of two hops and names the path", () => {
      const [rule] = rules("comments");
      expect(rule?.kind).toBe("global");
      expect(rule?.kind === "global" && rule.reason).toContain("post.team.members");
    });

    it("gives a model without a read rule no bucket at all", () => {
      expect(rules("unreadableRows")).toEqual([]);
    });
  });

  describe("what is ignored", () => {
    it("ignores field-level read rules", () => {
      expect(rules("guardedRows")).toEqual([{ kind: "global", reason: null }]);
    });

    it("ignores create, update and delete rules", () => {
      expect(rules("writeRuledRows")).toEqual([{ kind: "global", reason: null }]);
    });
  });

  describe("generation", () => {
    it("is stable across compilations", () => {
      expect(compiled().of("teamPosts").generation).toBe(compiled().of("teamPosts").generation);
    });

    it("is the same for rules that compile to the same buckets", () => {
      expect(compiled().of("splitRules").generation).toBe(compiled().of("eitherRows").generation);
    });

    it("differs when the buckets differ", () => {
      expect(compiled().of("ownedRows").generation).not.toBe(compiled().of("eitherRows").generation);
      expect(compiled().of("ownedRows").generation).not.toBe(compiled().of("teamMembers").generation);
    });
  });

  describe("the rest of the language that compiles", () => {
    it("keys a relation compared to auth() on its foreign key", () => {
      expect(rules("authoredRows")).toEqual([{ kind: "column", column: "authorId", authField: "id" }]);
    });

    it("keys a hop on the auth side on the row column, resolving the value per connection", () => {
      expect(rules("authTeamRows")).toEqual([{ kind: "column", column: "teamId", authField: "team.id" }]);
      expect(compiled().of("authTeamRows").dependencies).toEqual([]);
    });

    it("treats an 'all' rule as a read rule", () => {
      expect(rules("allRuleRows")).toEqual([ownerKey]);
    });

    it("inlines check() as the related model's read rules", () => {
      expect(rules("checkedRows")).toEqual([{ kind: "relation", column: "teamId", parameter: byTeamMembership }]);
      expect(compiled().of("checkedRows").dependencies).toEqual(["teamMembers"]);
    });

    it("compiles a rule inherited from a mixin type", () => {
      expect(rules("inheritedRows")).toEqual([ownerKey]);
    });

    it("compiles a delegate's rule on each concrete model", () => {
      expect(rules("delegatedRows")).toEqual([ownerKey]);
      expect(rules("delegatedSubRows")).toEqual([ownerKey]);
    });

    it("drops the auth() != null guard", () => {
      expect(rules("authRequiredRows")).toEqual([ownerKey]);
    });

    it("reads this.field like a plain field", () => {
      expect(rules("thisRows")).toEqual([ownerKey]);
    });

    it("drops `in` over literals and function filters under &&", () => {
      expect(rules("inListRows")).toEqual([ownerKey]);
      expect(rules("containsRows")).toEqual([ownerKey]);
    });
  });

  describe("row-only rules are global without complaint", () => {
    it("a comparison against now()", () => {
      expect(globalReason("nowRows")).toBeNull();
    });

    it("auth() == null", () => {
      expect(globalReason("anonymousRows")).toBeNull();
    });
  });

  describe("negations fall back to global and say why", () => {
    it("!", () => {
      expect(globalReason("negatedRows")).toContain("!");
    });

    it("the all-quantifier ![…]", () => {
      expect(globalReason("allQuantRows")).toContain("members![");
    });

    it("the none-quantifier ^[…]", () => {
      expect(globalReason("noneQuantRows")).toContain("members^[");
    });

    it("a hop inside a predicate", () => {
      expect(globalReason("innerHopRows")).toContain("user.teamId");
    });

    it("auth().id in a list column, for now", () => {
      expect(globalReason("listRows")).toContain("in ownerIds");
    });
  });

  describe("deny rules", () => {
    it("are ignored, because routing is a superset", () => {
      expect(rules("deniedRows")).toEqual([ownerKey]);
    });
  });
});
