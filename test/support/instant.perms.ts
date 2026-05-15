// instant.perms.ts - Test permissions for property-level permission testing
// Note: 'fields' property is supported by InstantDB but not in the TypeScript types yet

const rules = {
  users: {
    bind: ["isOwner", "auth.id != null && auth.id == data.id"],
    allow: {
      view: "true", // Anyone can view users
      create: "true",
      // Only the user themselves may update their own row. Used to verify
      // that wirer-driven reverse-link mutations on a non-owner do not
      // emit an update chunk against that user (which would fail this
      // rule and surface as a permission-denied transaction).
      update: "isOwner",
      delete: "true",
    },
    fields: {
      secretField: "isOwner", // Only owner can see secretField
    },
  },
  // Allow all operations on other test entities (no restrictions)
  profiles: { allow: { $default: "true" } },
  posts: { allow: { $default: "true" } },
  invitations: { allow: { $default: "true" } },
  chessMatchs: { allow: { $default: "true" } },
  skiMatchs: { allow: { $default: "true" } },
};

export default rules;
