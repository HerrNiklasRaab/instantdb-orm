// Docs: https://www.instantdb.com/docs/modeling-data

import { i } from "@instantdb/admin";

const _schema = i.schema({
  entities: {
    users: i.entity({
      name: i.string(),
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
      // Chess-specific (optional)
      timeControl: i.string().optional(),
      rated: i.boolean().optional(),
      // Ski-specific (optional)
      resort: i.string().optional(),
      skillLevel: i.string().optional(),
      // Soft delete
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
  },
  rooms: {},
});

// This helps Typescript display nicer intellisense
type _AppSchema = typeof _schema;
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
