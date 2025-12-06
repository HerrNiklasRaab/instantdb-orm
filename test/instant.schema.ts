// Docs: https://www.instantdb.com/docs/modeling-data

import { i } from "@instantdb/admin";

const _schema = i.schema({
  entities: {
    users: i.entity({
      name: i.string(),
      secretField: i.string().optional(), // For testing property-level permissions
      testDate: i.date().indexed().optional(), // For testing Date serialization/hydration
      createdAt: i.date().indexed(),
      updatedAt: i.date().indexed(),
      deletedAt: i.date().indexed().optional(),
    }),
    profiles: i.entity({
      bio: i.string().optional(),
      avatarUrl: i.string().optional(),
      createdAt: i.date().indexed(),
      updatedAt: i.date().indexed(),
      deletedAt: i.date().indexed().optional(),
    }),
    posts: i.entity({
      title: i.string(),
      content: i.string().optional(),
      createdAt: i.date().indexed(),
      updatedAt: i.date().indexed(),
      deletedAt: i.date().indexed().optional(),
    }),
    matchRequests: i.entity({
      type: i.string(), // discriminator: 'chess' | 'ski'
      createdAt: i.date().indexed(),
      updatedAt: i.date().indexed(),
      // Chess-specific (optional)
      timeControl: i.string().optional(),
      rated: i.boolean().optional(),
      // Ski-specific (optional)
      resort: i.string().optional(),
      skillLevel: i.string().optional(),
      // Soft delete
      deletedAt: i.date().indexed().optional(),
    }),
    // MTI: Each concrete class has its own table (separate from STI matchRequests)
    chessMatchs: i.entity({
      createdAt: i.date().indexed(),
      updatedAt: i.date().indexed(),
      timeControl: i.string(),
      rated: i.boolean(),
      deletedAt: i.date().indexed().optional(),
    }),
    skiMatchs: i.entity({
      createdAt: i.date().indexed(),
      updatedAt: i.date().indexed(),
      resort: i.string(),
      skillLevel: i.string(),
      deletedAt: i.date().indexed().optional(),
    }),
  },
  links: {
    usersProfile: {
      forward: {
        on: "users",
        has: "one",
        label: "profile",
      },
      reverse: {
        on: "profiles",
        has: "one",
        label: "user",
      },
    },
    postsAuthor: {
      forward: {
        on: "posts",
        has: "one",
        label: "author",
      },
      reverse: {
        on: "users",
        has: "many",
        label: "posts",
      },
    },
    usersReferredBy: {
      forward: {
        on: "users",
        has: "one",
        label: "referredBy",
      },
      reverse: {
        on: "users",
        has: "many",
        label: "referrals",
      },
    },
    matchRequestsRequester: {
      forward: {
        on: "matchRequests",
        has: "one",
        label: "requester",
      },
      reverse: {
        on: "users",
        has: "many",
        label: "matchRequests",
      },
    },
    // MTI links: each concrete table has its own relationship
    chessMatchsRequester: {
      forward: {
        on: "chessMatchs",
        has: "one",
        label: "requester",
      },
      reverse: {
        on: "users",
        has: "many",
        label: "chessMatchs",
      },
    },
    skiMatchsRequester: {
      forward: {
        on: "skiMatchs",
        has: "one",
        label: "requester",
      },
      reverse: {
        on: "users",
        has: "many",
        label: "skiMatchs",
      },
    },
  },
  rooms: {},
});

// This helps Typescript display nicer intellisense
type _AppSchema = typeof _schema;
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
