import { describe, it, expect } from "vitest";
import { i } from "@instantdb/core";
import { configureEntityMeta } from "../../src/object-graph/store/EntityMeta";

describe("Schema Timestamp Validation", () => {
  describe("field existence", () => {
    it("should throw error when entity is missing createdAt", () => {
      const invalidSchema = i.schema({
        entities: {
          users: i.entity({
            name: i.string(),
            updatedAt: i.date(),
            deletedAt: i.date().optional(),
          }),
        },
      });

      expect(() => { configureEntityMeta(invalidSchema); }).toThrow(
        'Entity "users" is missing required field "createdAt"'
      );
    });

    it("should throw error when entity is missing updatedAt", () => {
      const invalidSchema = i.schema({
        entities: {
          posts: i.entity({
            title: i.string(),
            createdAt: i.date(),
            deletedAt: i.date().optional(),
          }),
        },
      });

      expect(() => { configureEntityMeta(invalidSchema); }).toThrow(
        'Entity "posts" is missing required field "updatedAt"'
      );
    });

    it("should throw error when entity is missing deletedAt", () => {
      const invalidSchema = i.schema({
        entities: {
          comments: i.entity({
            content: i.string(),
            createdAt: i.date(),
            updatedAt: i.date(),
          }),
        },
      });

      expect(() => { configureEntityMeta(invalidSchema); }).toThrow(
        'Entity "comments" is missing required field "deletedAt"'
      );
    });
  });

  describe("optionality validation", () => {
    it("should throw if createdAt is optional", () => {
      const schema = i.schema({
        entities: {
          users: i.entity({
            createdAt: i.date().optional(),
            updatedAt: i.date(),
            deletedAt: i.date().optional(),
          }),
        },
      });

      expect(() => { configureEntityMeta(schema); }).toThrow(
        '"createdAt" must be required'
      );
    });

    it("should throw if updatedAt is optional", () => {
      const schema = i.schema({
        entities: {
          users: i.entity({
            createdAt: i.date(),
            updatedAt: i.date().optional(),
            deletedAt: i.date().optional(),
          }),
        },
      });

      expect(() => { configureEntityMeta(schema); }).toThrow(
        '"updatedAt" must be required'
      );
    });

    it("should throw if deletedAt is required (not optional)", () => {
      const schema = i.schema({
        entities: {
          users: i.entity({
            createdAt: i.date(),
            updatedAt: i.date(),
            deletedAt: i.date(),
          }),
        },
      });

      expect(() => { configureEntityMeta(schema); }).toThrow(
        '"deletedAt" must be optional'
      );
    });

    it("should not throw when all timestamp fields have correct optionality", () => {
      const schema = i.schema({
        entities: {
          users: i.entity({
            createdAt: i.date(),
            updatedAt: i.date(),
            deletedAt: i.date().optional(),
          }),
        },
      });

      expect(() => { configureEntityMeta(schema); }).not.toThrow();
    });
  });

  describe("system entities (starting with $)", () => {
    it("should throw if $system entity has required createdAt", () => {
      const schema = i.schema({
        entities: {
          $system: i.entity({
            createdAt: i.date(),
            updatedAt: i.date().optional(),
            deletedAt: i.date().optional(),
          }),
        },
      });

      expect(() => { configureEntityMeta(schema); }).toThrow(
        "must be optional for system entities"
      );
    });

    it("should throw if $system entity has required updatedAt", () => {
      const schema = i.schema({
        entities: {
          $system: i.entity({
            createdAt: i.date().optional(),
            updatedAt: i.date(),
            deletedAt: i.date().optional(),
          }),
        },
      });

      expect(() => { configureEntityMeta(schema); }).toThrow(
        "must be optional for system entities"
      );
    });

    it("should not throw when $system entity has all optional timestamps", () => {
      const schema = i.schema({
        entities: {
          $system: i.entity({
            createdAt: i.date().optional(),
            updatedAt: i.date().optional(),
            deletedAt: i.date().optional(),
          }),
        },
      });

      expect(() => { configureEntityMeta(schema); }).not.toThrow();
    });
  });
});
