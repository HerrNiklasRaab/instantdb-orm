// Docs: https://www.instantdb.com/docs/modeling-data

import { i } from "@instantdb/admin";

const _schema = i.schema({
  entities: {
    users: i.entity({
      name: i.string(),
      secretField: i.string().optional(), // For testing property-level permissions
      testDate: i.date().indexed().optional(), // For testing Date serialization/hydration
      status: i.string<"active" | "inactive" | "pending">().indexed().optional(),
      role: i.string<"admin" | "member" | "guest">().indexed().optional(),
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
    invitations: i.entity({
      modelType: i.string(), // discriminator: 'chess' | 'ski'
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
    // MTI: Each concrete class has its own table (separate from STI invitations)
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
    tags: i.entity({
      name: i.string(),
      createdAt: i.date().indexed(),
      updatedAt: i.date().indexed(),
      deletedAt: i.date().indexed().optional(),
    }),
    containers: i.entity({
      name: i.string(),
      createdAt: i.date().indexed(),
      updatedAt: i.date().indexed(),
      deletedAt: i.date().indexed().optional(),
    }),
    items: i.entity({
      name: i.string(),
      createdAt: i.date().indexed(),
      updatedAt: i.date().indexed(),
      deletedAt: i.date().indexed().optional(),
    }),
    listings: i.entity({
      priceAmount: i.number().optional(),
      priceCurrency: i.string().optional(),
      minBidAmount: i.number().optional(),
      minBidCurrency: i.string().optional(),
      slotStartHour: i.number().optional(),
      slotStartMinute: i.number().optional(),
      slotEndHour: i.number().optional(),
      slotEndMinute: i.number().optional(),
      flexPriceAmount: i.number().optional(),
      flexPriceDiscount: i.number().optional(),
      tags: i.json().optional(),
      schedule: i.json().optional(),
      slug: i.string().optional(),
      createdAt: i.date().indexed(),
      updatedAt: i.date().indexed(),
      deletedAt: i.date().indexed().optional(),
    }),
    validatingListings: i.entity({
      priceAmount: i.number().optional(),
      priceCurrency: i.string().optional(),
      slotStartHour: i.number().optional(),
      slotStartMinute: i.number().optional(),
      slotEndHour: i.number().optional(),
      slotEndMinute: i.number().optional(),
      createdAt: i.date().indexed(),
      updatedAt: i.date().indexed(),
      deletedAt: i.date().indexed().optional(),
    }),
    remappedListings: i.entity({
      priceCents: i.number(),
      priceCurrency: i.string(),
      createdAt: i.date().indexed(),
      updatedAt: i.date().indexed(),
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
    invitationsInviter: {
      forward: {
        on: "invitations",
        has: "one",
        label: "inviter",
      },
      reverse: {
        on: "users",
        has: "many",
        label: "invitations",
      },
    },
    // Subclass-only link: declared on `ChessInvitation` only. Used to
    // verify the hydrator tolerates schema relationships not present on
    // every concrete STI subclass.
    invitationsOpponent: {
      forward: {
        on: "invitations",
        has: "one",
        label: "opponent",
      },
      reverse: {
        on: "users",
        has: "one",
        label: "opponentInvitation",
      },
    },
    // MTI links: each concrete table has its own relationship
    chessMatchsInviter: {
      forward: {
        on: "chessMatchs",
        has: "one",
        label: "inviter",
      },
      reverse: {
        on: "users",
        has: "many",
        label: "chessMatchs",
      },
    },
    skiMatchsInviter: {
      forward: {
        on: "skiMatchs",
        has: "one",
        label: "inviter",
      },
      reverse: {
        on: "users",
        has: "many",
        label: "skiMatchs",
      },
    },
    // Many-to-many fixture: posts <-> tags
    postsTags: {
      forward: {
        on: "posts",
        has: "many",
        label: "tags",
      },
      reverse: {
        on: "tags",
        has: "many",
        label: "posts",
      },
    },
    // 1:N fixture where parent builds children inside its own constructor
    containersItems: {
      forward: {
        on: "items",
        has: "one",
        label: "container",
      },
      reverse: {
        on: "containers",
        has: "many",
        label: "items",
      },
    },
  },
  rooms: {},
});

// This helps Typescript display nicer intellisense
type _AppSchema = typeof _schema;
type AppSchema = _AppSchema;
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
