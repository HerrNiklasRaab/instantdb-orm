// instant.perms.ts - Test permissions for property-level permission testing
// Note: 'fields' property is supported by InstantDB but not in the TypeScript types yet

const rules = {
  users: {
    bind: ["isOwner", "auth.id != null && auth.id == data.id"],
    allow: {
      view: "true", // Anyone can view users
      create: "true",
      update: "true",
      delete: "true",
    },
    fields: {
      secretField: "isOwner", // Only owner can see secretField
    },
  },
  // Allow all operations on other test entities (no restrictions)
  profiles: { allow: { $default: "true" } },
  posts: { allow: { $default: "true" } },
  matchRequests: { allow: { $default: "true" } },
  chessMatchs: { allow: { $default: "true" } },
  skiMatchs: { allow: { $default: "true" } },
};

export default rules;
