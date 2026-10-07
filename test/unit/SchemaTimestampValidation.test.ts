import { describe, it, expect } from "vitest";
import type { FieldDef, SchemaDef } from "@zenstackhq/schema";
import { configureEntityMeta } from "../../src/object-graph/store/EntityMeta";

function schemaWith(
  entity: string,
  columns: Record<string, Pick<FieldDef, "type" | "optional">>
): SchemaDef {
  const fields: Record<string, FieldDef> = { id: { name: "id", type: "String", id: true } };
  for (const [name, column] of Object.entries(columns)) fields[name] = { name, ...column };
  return {
    provider: { type: "postgresql" },
    models: { [entity]: { name: entity, fields, uniqueFields: {}, idFields: ["id"] } },
    plugins: {},
  };
}

describe("Schema Timestamp Validation", () => {
  describe("field existence", () => {
    it("should throw error when entity is missing createdAt", () => {
      const invalidSchema = schemaWith("users", { name: { type: "String" }, updatedAt: { type: "DateTime" }, deletedAt: { type: "DateTime", optional: true } });

      expect(() => { configureEntityMeta(invalidSchema); }).toThrow(
        'Entity "users" is missing required field "createdAt"'
      );
    });

    it("should throw error when entity is missing updatedAt", () => {
      const invalidSchema = schemaWith("posts", { title: { type: "String" }, createdAt: { type: "DateTime" }, deletedAt: { type: "DateTime", optional: true } });

      expect(() => { configureEntityMeta(invalidSchema); }).toThrow(
        'Entity "posts" is missing required field "updatedAt"'
      );
    });

    it("should throw error when entity is missing deletedAt", () => {
      const invalidSchema = schemaWith("comments", { content: { type: "String" }, createdAt: { type: "DateTime" }, updatedAt: { type: "DateTime" } });

      expect(() => { configureEntityMeta(invalidSchema); }).toThrow(
        'Entity "comments" is missing required field "deletedAt"'
      );
    });
  });

  describe("optionality validation", () => {
    it("should throw if createdAt is optional", () => {
      const schema = schemaWith("users", { createdAt: { type: "DateTime", optional: true }, updatedAt: { type: "DateTime" }, deletedAt: { type: "DateTime", optional: true } });

      expect(() => { configureEntityMeta(schema); }).toThrow(
        '"createdAt" must be required'
      );
    });

    it("should throw if updatedAt is optional", () => {
      const schema = schemaWith("users", { createdAt: { type: "DateTime" }, updatedAt: { type: "DateTime", optional: true }, deletedAt: { type: "DateTime", optional: true } });

      expect(() => { configureEntityMeta(schema); }).toThrow(
        '"updatedAt" must be required'
      );
    });

    it("should throw if deletedAt is required (not optional)", () => {
      const schema = schemaWith("users", { createdAt: { type: "DateTime" }, updatedAt: { type: "DateTime" }, deletedAt: { type: "DateTime" } });

      expect(() => { configureEntityMeta(schema); }).toThrow(
        '"deletedAt" must be optional'
      );
    });

    it("should not throw when all timestamp fields have correct optionality", () => {
      const schema = schemaWith("users", { createdAt: { type: "DateTime" }, updatedAt: { type: "DateTime" }, deletedAt: { type: "DateTime", optional: true } });

      expect(() => { configureEntityMeta(schema); }).not.toThrow();
    });
  });

  describe("system entities (starting with $)", () => {
    it("should throw if $system entity has required createdAt", () => {
      const schema = schemaWith("$system", { createdAt: { type: "DateTime" }, updatedAt: { type: "DateTime", optional: true }, deletedAt: { type: "DateTime", optional: true } });

      expect(() => { configureEntityMeta(schema); }).toThrow(
        "must be optional for system entities"
      );
    });

    it("should throw if $system entity has required updatedAt", () => {
      const schema = schemaWith("$system", { createdAt: { type: "DateTime", optional: true }, updatedAt: { type: "DateTime" }, deletedAt: { type: "DateTime", optional: true } });

      expect(() => { configureEntityMeta(schema); }).toThrow(
        "must be optional for system entities"
      );
    });

    it("should not throw when $system entity has all optional timestamps", () => {
      const schema = schemaWith("$system", { createdAt: { type: "DateTime", optional: true }, updatedAt: { type: "DateTime", optional: true }, deletedAt: { type: "DateTime", optional: true } });

      expect(() => { configureEntityMeta(schema); }).not.toThrow();
    });
  });
});
