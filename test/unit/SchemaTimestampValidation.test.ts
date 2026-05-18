import { describe, it, expect } from "vitest";
import { configureEntityMeta } from "../../src/object-graph/store/EntityMeta";

describe("Schema Timestamp Validation", () => {
  describe("field existence", () => {
    it("should throw error when entity is missing createdAt", () => {
      const invalidSchema = {
        entities: {
          users: {
            attrs: {
              name: { valueType: "string", required: true },
              updatedAt: { valueType: "date", required: true },
              deletedAt: { valueType: "date", required: false },
            },
            links: {},
          },
        },
        links: {},
      };

      expect(() => { configureEntityMeta(invalidSchema); }).toThrow(
        'Entity "users" is missing required field "createdAt"'
      );
    });

    it("should throw error when entity is missing updatedAt", () => {
      const invalidSchema = {
        entities: {
          posts: {
            attrs: {
              title: { valueType: "string", required: true },
              createdAt: { valueType: "date", required: true },
              deletedAt: { valueType: "date", required: false },
            },
            links: {},
          },
        },
        links: {},
      };

      expect(() => { configureEntityMeta(invalidSchema); }).toThrow(
        'Entity "posts" is missing required field "updatedAt"'
      );
    });

    it("should throw error when entity is missing deletedAt", () => {
      const invalidSchema = {
        entities: {
          comments: {
            attrs: {
              content: { valueType: "string", required: true },
              createdAt: { valueType: "date", required: true },
              updatedAt: { valueType: "date", required: true },
            },
            links: {},
          },
        },
        links: {},
      };

      expect(() => { configureEntityMeta(invalidSchema); }).toThrow(
        'Entity "comments" is missing required field "deletedAt"'
      );
    });
  });

  describe("optionality validation", () => {
    it("should throw if createdAt is optional", () => {
      const schema = {
        entities: {
          users: {
            attrs: {
              createdAt: { valueType: "date", required: false }, // optional - invalid
              updatedAt: { valueType: "date", required: true },
              deletedAt: { valueType: "date", required: false },
            },
            links: {},
          },
        },
        links: {},
      };

      expect(() => { configureEntityMeta(schema); }).toThrow(
        '"createdAt" must be required'
      );
    });

    it("should throw if updatedAt is optional", () => {
      const schema = {
        entities: {
          users: {
            attrs: {
              createdAt: { valueType: "date", required: true },
              updatedAt: { valueType: "date", required: false }, // optional - invalid
              deletedAt: { valueType: "date", required: false },
            },
            links: {},
          },
        },
        links: {},
      };

      expect(() => { configureEntityMeta(schema); }).toThrow(
        '"updatedAt" must be required'
      );
    });

    it("should throw if deletedAt is required (not optional)", () => {
      const schema = {
        entities: {
          users: {
            attrs: {
              createdAt: { valueType: "date", required: true },
              updatedAt: { valueType: "date", required: true },
              deletedAt: { valueType: "date", required: true }, // required - invalid
            },
            links: {},
          },
        },
        links: {},
      };

      expect(() => { configureEntityMeta(schema); }).toThrow(
        '"deletedAt" must be optional'
      );
    });

    it("should not throw when all timestamp fields have correct optionality", () => {
      const schema = {
        entities: {
          users: {
            attrs: {
              createdAt: { valueType: "date", required: true },
              updatedAt: { valueType: "date", required: true },
              deletedAt: { valueType: "date", required: false },
            },
            links: {},
          },
        },
        links: {},
      };

      expect(() => { configureEntityMeta(schema); }).not.toThrow();
    });
  });

  describe("system entities (starting with $)", () => {
    it("should throw if $system entity has required createdAt", () => {
      const schema = {
        entities: {
          $system: {
            attrs: {
              createdAt: { valueType: "date", required: true }, // should be optional
              updatedAt: { valueType: "date", required: false },
              deletedAt: { valueType: "date", required: false },
            },
            links: {},
          },
        },
        links: {},
      };

      expect(() => { configureEntityMeta(schema); }).toThrow(
        "must be optional for system entities"
      );
    });

    it("should throw if $system entity has required updatedAt", () => {
      const schema = {
        entities: {
          $system: {
            attrs: {
              createdAt: { valueType: "date", required: false },
              updatedAt: { valueType: "date", required: true }, // should be optional
              deletedAt: { valueType: "date", required: false },
            },
            links: {},
          },
        },
        links: {},
      };

      expect(() => { configureEntityMeta(schema); }).toThrow(
        "must be optional for system entities"
      );
    });

    it("should not throw when $system entity has all optional timestamps", () => {
      const schema = {
        entities: {
          $system: {
            attrs: {
              createdAt: { valueType: "date", required: false },
              updatedAt: { valueType: "date", required: false },
              deletedAt: { valueType: "date", required: false },
            },
            links: {},
          },
        },
        links: {},
      };

      expect(() => { configureEntityMeta(schema); }).not.toThrow();
    });
  });
});
