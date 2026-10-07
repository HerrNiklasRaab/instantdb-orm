# Sync Package — Test Authoring Rules

## Persistence: go through the store, not the DB

Integration tests **must** drive all writes through `store.transaction(...)` and reads through `store.queryModel(...)` / subscriptions. Do **not** commit a hand-built `Transaction` on a client to set up state, mutate rows, or simulate other clients.

```ts
// ✅ Good — exercises the same path production code uses
await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags([])));

// ❌ Bad — bypasses the framework you're trying to test
await client.commit(new Transaction().update("listings", id, { priceAmount: -5 }));
```

The reason: a test that hand-builds a transaction to set up state isn't testing the integration of *your* code with the sync engine — it's testing that the database stores what you tell it to. Hydration, change tracking, identity-map population, reverse-link wiring, and every other framework concern can only be exercised when writes go through `RootStore`.

**Narrow exception — admin-context corruption setup.** Hydration-edge-case tests that need stored data the model layer cannot produce (mixed-null spread columns, values that would fail constructor validation, rows authored by an admin migration) may commit `new Transaction().update(entity, id, {...})` on a service client (`connectTestClient()`) to bootstrap the row state. The exception applies to *setup only* — the test's act/assert phases still go through `storeB.queryModel(...)` etc. Never hand-build a transaction on a user's client; only on the service client, and only for edge-case setup.

If a test isn't a hydration edge case but still wants a hand-built transaction, restate it through the store. The bypass exception is narrow.

## Unit vs integration

- **`test/unit/`** — pure logic, no DB, no framework internals. Things that work on plain objects.
- **`test/integration/`** — anything that touches `RootStore`, `ModelSnapshot`, `ModelHydrator`, `ChangeTracker`, or any other framework internal, **or** anything that needs a real database or sync server. Tests that reach into framework internals belong here even when they don't need network.

If you find yourself importing from `src/object-graph/persistence/`, `src/object-graph/store/`, or `src/object-graph/IdentityMap.ts` in a unit test, move the test to `test/integration/`.
