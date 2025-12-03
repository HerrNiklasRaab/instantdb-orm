// Docs: https://www.instantdb.com/docs/modeling-data

import { i } from "@instantdb/admin";

const _schema = i.schema({
  entities: {
    $files: i.entity({
      deletedAt: i.date().indexed().optional(),
      path: i.string().unique().indexed(),
      url: i.string(),
    }),
    $users: i.entity({
      deletedAt: i.date().indexed().optional(),
      email: i.string().unique().indexed().optional(),
      imageURL: i.string().optional(),
      type: i.string().optional(),
    }),
    accounts: i.entity({
      accessToken: i.string().optional(),
      accessTokenExpiresAt: i.date().optional(),
      accountId: i.string().indexed(),
      createdAt: i.date().indexed(),
      deletedAt: i.date().indexed().optional(),
      idToken: i.string().optional(),
      password: i.string().optional(),
      providerId: i.string().indexed(),
      refreshToken: i.string().optional(),
      refreshTokenExpiresAt: i.date().optional(),
      scope: i.string().optional(),
      updatedAt: i.date().indexed(),
    }),
    sessions: i.entity({
      createdAt: i.date().indexed(),
      deletedAt: i.date().indexed().optional(),
      expiresAt: i.date().indexed(),
      ipAddress: i.string().optional(),
      token: i.string().unique().indexed(),
      updatedAt: i.date().indexed(),
      userAgent: i.string().optional(),
    }),
    users: i.entity({
      createdAt: i.date().indexed(),
      deletedAt: i.date().indexed().optional(),
      email: i.string().unique().indexed(),
      emailVerified: i.boolean(),
      image: i.string().optional(),
      name: i.string(),
      updatedAt: i.date().indexed(),
    }),
    verifications: i.entity({
      createdAt: i.date().indexed(),
      deletedAt: i.date().indexed().optional(),
      expiresAt: i.date().indexed(),
      identifier: i.string().indexed(),
      updatedAt: i.date().indexed(),
      value: i.string(),
    }),
  },
  links: {
    $usersLinkedPrimaryUser: {
      forward: {
        on: "$users",
        has: "one",
        label: "linkedPrimaryUser",
        onDelete: "cascade",
      },
      reverse: {
        on: "$users",
        has: "many",
        label: "linkedGuestUsers",
      },
    },
    accountsUser: {
      forward: {
        on: "accounts",
        has: "one",
        label: "user",
      },
      reverse: {
        on: "users",
        has: "many",
        label: "accounts",
      },
    },
    sessionsUser: {
      forward: {
        on: "sessions",
        has: "one",
        label: "user",
      },
      reverse: {
        on: "users",
        has: "many",
        label: "sessions",
      },
    },
    users$user: {
      forward: {
        on: "users",
        has: "one",
        label: "$user",
      },
      reverse: {
        on: "$users",
        has: "one",
        label: "user",
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
