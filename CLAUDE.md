# Sync Package - Architecture Guide

A typed, reactive ORM over Postgres (via ZenStack) with MobX-powered change tracking.

## Overview

This package bridges domain models and a sync server. There is one client, `SyncClient` (`src/client/`), used wherever the code runs — device, browser, or backend code. It holds a connection (`Socket`) and its own SQLite replica (`LocalReplica`); reads are answered from the replica, which changes only through what the server sends. A `RootStore` is given one client.

`SyncServer` (`src/server/`) owns Postgres (through ZenStack, which owns the schema and access policies), the transaction log and the bucket log. `ClientConnection` is one connected device: its socket, its held buckets, its outbound queue. It acts through a `Principal`: who is acting and with what rights — every pull, commit and bucket read runs under that identity's policies. `server.unrestricted()` is the service principal. Neither is ever used as a client itself.

Shared by client, server, wire and log, and never touching a database: `src/transactions/` (`Transaction`, its changes, outcomes and effects) and `src/queries/` (`SyncQuery`, `QueryResult`, `Row`). What the schema says lives with the schema in `src/schema/`: `SyncSchema.of(schema)` is the one object the engine asks — which models sync (`models`), which fields the server may withhold (`guarded`), how a model's links are stored (`links(entity)`, a `ModelLinks`). `src/subscriptions/` holds everything about live answers (`LiveSubscription`, the resilient wrapper, the observer). `src/storage/` reads and writes rows through a ZenStack client, the same code on Postgres and SQLite (`RowStore`, join tables); it depends on the shared folders, never the other way round, and only `src/server/` holds what only the server needs (the change feed, `TransactionRecord`, `Filing`).

Backend code that runs beside the server connects like any other client, over `inProcessSocketPair()` instead of a WebSocket. Moving it to its own process later means swapping that socket for a `WebSocketConnection`, nothing else:

```ts
const [clientEnd, serverEnd] = inProcessSocketPair();
server.accept(serverEnd, server.unrestricted());
const client = new SyncClient(clientSchema, () => clientEnd, LocalReplica.open(clientSchema, dialect));
const store = new RootStore({ client });
```

A client in another process connects over a WebSocket and says who it is in its first frame, because a browser cannot set headers on a WebSocket: `new Credential(token).presentOn(socket)`. On the server, `SocketAdmission` reads that frame (holding back whatever arrives meanwhile, `WaitingSocket`), asks `SyncCredentials` for the `Principal` — the service for the configured service token, otherwise whoever the app's `SessionLookup` says the token belongs to — and accepts the socket, or closes it:

```ts
const credentials = new SyncCredentials(server, sessions, serviceToken); // sessions: the app's SessionLookup
const admission = new SocketAdmission(server, credentials);
wss.on("connection", (ws) => admission.admit(new WebSocketConnection(ws)));
// client
new SyncClient(schema, () => new Credential(token).presentOn(new WebSocketConnection(new WebSocket(url))), replica);
```

Key characteristics:
- **Object-Oriented**: Models are entities with behavior, not data bags
- **Reactive**: MobX observables automatically track mutations
- **Identity-Managed**: One instance per entity ID (identity map pattern)
- **Inheritance Support**: Single-Table (STI) and Multi-Table (MTI) inheritance

## Core Concepts

### Model (`src/object-graph/Model.ts`)
Abstract base class for all domain entities. Every model must:
1. Extend `Model`
2. Override the protected `makeObservable()` method to register observable fields
3. Call `super.makeObservable()` first in the override, then add own fields

```typescript
import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model, model, field } from "@upfor/sync";

@model
export class User extends Model {
  @field()
  private _name: string;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      _name: observable,
    } as any);
  }

  constructor(name: string, id?: string) {
    super(id);
    this._name = name;
    this.initTracking();
  }

  get name() { return this._name; }
  set name(v: string) { this._name = v; }
}
```

**Important for inheritance**: Each class overrides `makeObservable()`, calls `super.makeObservable()`, then registers its OWN fields only. The `initTracking()` method calls `this.makeObservable()` which invokes the full override chain, so all fields exist when observables are set up.

### RootStore (`src/object-graph/store/RootStore.ts`)
Central coordinator for all persistence operations:
- `transaction(() => { ... })` - Persists tracked model changes as one `Transaction`
- `queryModel(EntityClass)` - Fetches and hydrates entities
- `subscribeModel(EntityClass, callback)` - Live subscriptions

## Testing

Integration tests run three databases in one process: the real `SyncServer` on Postgres (PGlite/WASM, same migration SQL as production; vendored from `vendor/pglite-0.5.8-logical.tgz`, PGlite 0.5.8 rebuilt with electric-sql/pglite#1047 so logical decoding works — back to the npm release once that ships) and one SQLite replica (sql.js/WASM) per client. Clients talk to the server over a real WebSocket on a Unix socket file (no port; one endpoint per test file, see `test/integration/support/WebSocketEndpoint.ts`). `SYNC_TEST_TRANSPORT=in-process` swaps in `inProcessSocketPair()` instead; the suite must pass both ways.

```ts
const client = connectTestClient();           // new client: own replica + connection, service access
const alice = connectTestClientAs(email);     // new client, policies enforced
const store = new RootStore({ client });
const { client, replica } = await openTestClient(); // when the test inspects the replica itself
await writeStraightToPostgres(sql);           // a writer that knows nothing of the sync server
await stopServer(); await startServer();      // the server process goes away and comes back
const sqlite = new PausableSqlite();          // the device's SQLite, stoppable between two statements
await Device.open(undefined, { sqlite });     // … sqlite.pauseAfterFirstWriteTo("posts"), sqlite.resume()
```

How data moves:

- **Buckets**: a client's replica is the union of the *buckets* it holds. Buckets are compiled from the read policies (`src/buckets/`, see below): a row is filed under keys computed from its own columns (`roomMessages/roomId[7]`), and an identity holds the keys its own rows say it holds (`roomMembers where userId = me` → `roomMessages/roomId[…]`). A service client holds everything. On connect the server sends each held bucket whole; from then on it sends only what changes inside held buckets.
- **Query** (`query`, `queryModel`): while connected, a one-off query still asks the server first (policy-filtered pull into the replica), then answers from the replica. Offline it answers from the replica.
- **Commit**: a `Transaction` (id + a list of `Change`s) goes to the server, which applies it and appends it to the log in one database transaction: one `transactions` row (author, status, reason, time) and one `changes` row per change, indexed by entity and row id. The author gets its *effect* once the change feed has filed it: the verdict plus the rows it touched.
- **`store.transaction(fn)`** returns a promise of `fn`'s result that resolves once the change is applied locally — online or offline alike, without waiting for the server — and rejects only when `fn` throws. Its `.settled({ signal? })` waits for the server's verdict and resolves `{ result, outcome }` with `outcome.status` `committed` or `denied`: a value, never an exception. Offline it waits until the device is back online; the signal stops waiting. Code that acts on the outside world after a write (a push, an email) awaits `.settled()` and acts only on `committed`. On the client, `submit` applies and sends, `verdict(id)` waits for the answer (also one recorded before it was asked for), and `commit` is the two together.
- **A row carries its own links**: a `create` or `update` change holds the row's to-one links by relation field (`{ kind: "create", entity: "messages", id, values, links: { chat: c1, sender: p1 } }`, `null` clears one), so the server writes the row whole — the foreign keys are in the insert, which access policies judge (`@@allow('create', room.members?[userId == auth().id])` holds only this way). The store builds it that way (`TransactionDraft`): whichever side the code touched (`message.chat = chat` or `chat.messages.push(message)`), the link lands on the row holding the key. `link`/`unlink` changes are many-to-many only; the server refuses one on a to-one field. The server inserts new rows in the order the transaction lists them, so the store lists each after the new rows it links to; a link that would close a cycle among new rows goes into an update, which the server applies after every create. A transaction listed in an impossible order is denied like any other constraint violation. A one-to-one key is first released by any other row holding it.
- **Change feed** (`src/server/ChangeFeed.ts`): the server learns of every committed write from Postgres's WAL, through a logical replication slot (`sync`, `pgoutput`, publication `sync`), whoever made the write — the sync server, the auth provider, a migration, a hand fix in `psql`. Per commit, in commit order, it hands out the next tick (the server's logical clock), files every written row into its buckets from the WAL's old and new row (`bucketLog`: bucket, tick, entity, id, removed) and tells the holders of those buckets, and only them, what changed (`changed`: the rows as each holder may see them, plus ids to drop). A commit without a sync log entry is an outside write and is logged with no author. The tick is set by the feed, not on insert, so it follows commit order and a bucket cursor never passes a transaction that committed late. The feed saves how far it filed in the same database transaction as the filing (`changeFeedPosition`) and advances the slot after, so a feed stopped in between neither loses nor repeats a commit; on `start` it first files whatever was committed while no server ran. The sync server's own writes wake the feed at once; writes by anyone else are noticed within a second. One server process per database reads the slot. Every synced table needs `REPLICA IDENTITY FULL` (an update must carry the whole old row) — `start` refuses to run otherwise; migration `0002_change_feed` sets it and creates the publication.
- **Subscribe**: answered from the replica, re-read whenever the replica changes. No pull: a subscribed query's rows are in the replica because their buckets are held. `subscribeQueryIsolated` hands its handler the newest snapshot only: snapshots that arrive while a handler runs collapse into the one run that follows, so a snapshot read before a handler's own writes landed is never acted on after them (a reactor would otherwise do its work twice).
- **Rebasing**: whatever the server sends — a pull's answer, another client's change, the verdict on an earlier transaction of this client's, a gained bucket — may predate this client's own unconfirmed transactions. After writing any server message into the replica, the client applies those transactions again on top, in the same `ReplicaGate` write, before any read: the replica always reads as the server's state plus this client's unconfirmed writes.
- **Membership changes**: a write to a row that a parameter query reads (a `roomMembers` row) re-evaluates the held buckets of the identities that row names. What it gives and takes travels in the same message as the transaction's rows (`changed.scope` / `effect.scope`: gained buckets whole, lost buckets to drop by their filter): one tick is one message per device, so a new member never sees the membership without what it opens. A standalone `scope` message is sent only when a transaction changed access and no rows the device holds, and on reconnect.
- **Applying is one step**: the client writes each server message, and each local transaction, while holding `ReplicaGate`; reads of the replica (queries, subscription re-reads) wait for writes under way and queued, so none sees part of a transaction. A device's SQLite driver hands the event loop back between statements, which is when a read could otherwise slip in.
- **Denial**: a transaction the server refuses (access policy, constraint) is applied nowhere but still logged, with `status: "denied"` and the reason, and announced to its author only (committed through that connection, or signed by that identity). The author's effect carries the server's current rows for everything the transaction touched — applying it is the undo, so taking a denied transaction back is the same code path as applying any effect, and works after a restart. The denial is undone in the models before `.settled()` resolves, and also reported through `RootStoreConfig.onTransactionDenied` (console warning by default) — however late it arrives, also after a restart, when no `.settled()` is waiting any more.

### Presence

Live state that is passed on and never stored — who is in a chat, who is typing. `store.presence(Chat, chatId)` enters the row's presence room and returns its `PresenceRoom`: `set(state)` (any JSON; `null` stays present without one), `peers` (everyone else, `{ userId, state }`, observable), `refused`, `leave()`. Every `presence()` call holds the room and shares one handle per client; the device leaves once each holder has called `leave()`, after which the handle sends nothing. Whoever may read the row may be in its room: the server checks the device's own read policy on entering (`Principal.canRead`) and again whenever a transaction changes that identity's access; a device that loses access is put out (`presenceRefused`). The rooms live in the server process's memory (`PresenceRooms`): nothing reaches Postgres, the log or a replica. A dropped connection leaves every room; on reconnect the client enters them again with its last state. Several server processes would need the rooms shared between them.

### Offline

The client works without a connection and reconnects on its own (retry with backoff, from 50 ms up to 1 s). It can be constructed offline.

- **Reads** answer from the replica. A query pulls from the server first only while connected.
- **Writes** are applied to the replica at once and recorded as `pending` in the client's local log — the same `transactions` and `changes` models as the server, in SQLite; the client pushes its own schema, in which every field the server may withhold (a field-level read policy) is optional — a row arrives without it even when the server's column is required, and `HiddenFields` keeps withheld apart from empty. Only own transactions are ever pending, and they are resent in `loggedAt` order. Offline, `commit` resolves with `status: "pending"`; the transaction is sent on the next connection, in the order made. Pending transactions survive an app restart because they live in SQLite.
- **Subscriptions** keep answering from the replica through a disconnect and report no fault; an identical answer is not re-delivered.
- **Reconnect**: the client says `hello` with one cursor per bucket it holds (`bucketCursors`, in SQLite) and the policy generation each model was downloaded under. The server answers in order: `resync` for models whose read policy changed (the client drops those rows and starts over), `scope` for buckets gained (whole) and lost (dropped by filter), one `changed` with everything filed in the kept buckets after their cursors, then `ready`. Reads wait for `ready` on the first connection (or for the connection to fail). Then the client resends its pending transactions. Catch-up cost is what changed in the buckets held, never the whole log.
- **Resend**: a transaction the server already logged is not applied again; the author just gets the recorded effect once more.
- **Whole-table answers evict**: `queryModel` / `subscribeModel` evict persisted models the answer no longer lists (hard-deleted or hidden rows whose tombstone was never seen). Models the server has not confirmed yet are left alone.

Not built: more than one server process per database (only one may read the slot; the others would need the feed's filings passed on), conflict rules for the same row edited on two clients (last write to the server wins, column-wise; clearing a to-one link is such a write and wins over a concurrent reassignment), client-side policy checks, bucket keys on `auth()` fields other than `id`, interest partitions for public models (a public model is one global bucket every client replicates whole), compaction of `bucketLog`.

Consequences for tests: after another client commits, `await waitFor(...)` before asserting replicated state. The replica holds confirmed server state only; unconfirmed edits live in the models (`ScopedTransaction`), not in SQLite.

Queries use ZenStack's `findMany` shape, keyed by model: `{ posts: { where: { id }, include: { author: true } } }`. `RootStore` adds the id-only includes hydration needs. Caller-level `select` is not supported: replicated rows are whole rows.

#### Buckets, compiled from policies

`BucketScheme.compile(schema)` (`src/buckets/`) turns every model's `@@allow('read')` rules into bucket rules: `auth().id == ownerId` → a `ColumnBucket` keyed on `ownerId`; `members?[userId == auth().id]` → a `RelationBucket` keyed on the row's id with a `ParameterQuery` over `roomMembers`; `room.hostId == auth().id` and `check(room)` → relation buckets keyed on the foreign key; `||` → one rule per branch; a row filter under `&&` is dropped (the pull applies it). What cannot be keyed — `!=`, inequalities against `auth()`, negated quantifiers, paths of two hops, `auth().id in list` — falls back to one `GlobalBucket` with the offending expression as `reason`; row-only rules are global without complaint. Routing is a superset: every row a client is shown still passes the policy client. `@@deny` is therefore ignored. Each `ModelScheme` has a `generation` fingerprint; a client that downloaded a model under another generation is told to resync it. The 36 cases are in `test/unit/BucketCompiler.test.ts` against `test/support/buckets.zmodel`.

#### One domain, two schemas

The app declares its entities and policies once (a `domain.zmodel` with no datasource) and compiles them twice, from two generation roots that differ only in datasource and in which of this package's files they import:

| Root | Datasource | Imports | Used by |
|---|---|---|---|
| `server.zmodel` | postgresql | domain + `@upfor/sync/src/schema/log` + `.../server` | `SyncServer`, Prisma migration |
| `client.zmodel` | sqlite | domain + `.../log` + `.../client` | `SyncClient`, `LocalReplica`, `RootStore` |

ZModel resolves imports relative to the importing file and they must come first. `log.zmodel` holds `transactions` and `changes`, kept on both sides. `client.zmodel` holds the replica's own tables (`hiddenFields`, `bucketCursors`); `server.zmodel` holds the server's (`bucketLog`). Neither reaches the other side's database. `@@meta('sync', 'internal')` marks all of them: not an entity, not queryable through a store, not replicated. A unit test (`SchemaSplit.test.ts`) asserts both roots describe the same entities.

Queries are typed per generated schema, and each contains the domain and the log, so `client.changes.findMany({ where: { entity: "posts", entityId } })` is typed on either side. A client-only or server-only model simply does not exist in the other schema.

The package generates its own typed views (`src/schema/generated/{log,client,server}/`, from `src/schema/roots/`). `logClientOf(client)` narrows any ZenStack client whose schema imports `log.zmodel` to `LogClient`; `replicaClientOf` and `serverClientOf` do the same for `client.zmodel` and `server.zmodel`. Only entity access, whose model names arrive at runtime, stays untyped.

### Deleting Models

Use model methods inside a transaction:

```typescript
await store.transaction(() => {
  model.delete(); // soft-delete first, then physically delete
});

await store.transaction(() => {
  model.softDelete(); // only when the row must remain as a tombstone
});
```

Rules:
- `delete()` is the normal deletion path.
- `softDelete()` is explicit tombstone behavior; do not use it unless the domain needs retained deleted rows.
- If physical delete fails, the row remains soft-deleted.
- Do not delete shared rows that other users still need.

### IdentityMap (`src/object-graph/IdentityMap.ts`)
Caches model instances by ID. Ensures reference equality:
```typescript
store.getById(User, "123") === store.getById(User, "123") // Always true
```

### ChangeTracker (`src/object-graph/persistence/ChangeTracker.ts`)
Automatically tracks mutations on model instances:
- Scalar changes (name, date, etc.)
- Relationship additions/removals
- Distinguishes new vs existing entities

### ModelHydrator (`src/object-graph/store/ModelHydrator.ts`)
Reconstructs model instances from raw rows. Hydration bypasses constructors, so constructors can have required parameters, validation, and business logic.

## Inheritance Strategies

### Single-Table Inheritance (STI)
Multiple classes share one database table. Use when subclasses have similar fields.

**Requirements:**
- Abstract base class (no `@model`)
- Concrete subclasses with `@model` decorator
- `modelType` getter returning a literal string discriminator

```typescript
// Abstract base - NO @model
export abstract class Invitation extends Model {
  abstract readonly modelType: string;  // Discriminator field
  // shared fields...
}

// Concrete - HAS @model + modelType getter
@model
export class ChessInvitation extends Invitation {
  get modelType(): "chess" { return "chess"; }  // Determines table storage
  // chess-specific fields...
}

@model
export class SkiInvitation extends Invitation {
  get modelType(): "ski" { return "ski"; }
}
```

Both store in `invitations` table with `modelType` column distinguishing them.

### Multi-Table Inheritance (MTI)
Each concrete class gets its own database table. Use when subclasses have very different fields.

**Requirements:**
- Abstract base class (no `@model`)
- Concrete subclasses with `@model` decorator
- **No** `modelType` getter

```typescript
// Abstract base - NO @model
export abstract class Match extends Model {
  // shared fields...
}

// Each gets its own table
@model
export class ChessMatch extends Match { }  // → chessMatchs table

@model
export class SkiMatch extends Match { }    // → skiMatchs table
```

## Decorators

### `@model` Decorator
Marks a class as a persistable entity. Required on all concrete model classes.

**Always pass an explicit entity name: `@model("entityName")`.** Never rely on auto-derivation.

```typescript
@model("users")
export class User extends Model { ... }

@model("parties")
export class Party extends Model { ... }

@model("installations")
export class Installation extends Model { ... }
```

The decorator can also auto-derive the entity name from the class name (`User` → `users`), but that mode is **broken under production bundlers**: SWC/Terser mangle class names (`User` → `u`), so `target.name` returns the minified identifier and `deriveEntityName` produces nonsense like `"us"`. Dev mode works (no mangling), so the failure only surfaces in `next build` / EAS prod builds with a confusing `Unknown entity type: ...` thrown deep inside the store.

Pass the entity name as a string literal — string literals are not mangled, so the registration matches the schema regardless of bundler settings.

### `@field()` Decorator
Registers field-to-schema attribute mappings for hydration. Use when the field name differs from the schema attribute name.

```typescript
import { Model, model, field } from "@upfor/sync";

@model
export class User extends Model {
  @field()  // Maps _name → name in schema (strips _ prefix)
  private _name: string;

  @field({ attributeName: "displayName" })  // Maps customField → displayName in schema
  public customField: string;
}
```

**Why it's needed:** Hydration uses `Object.create(prototype)` to bypass constructors. Without the decorator, the hydrator cannot discover field-to-schema mappings since the instance has no properties until the constructor runs.

**When to use:**
- Private fields with `_` prefix (maps `_foo` → `foo` automatically)
- Any field where the field name differs from the schema attribute name (use `attributeName` option)
- All timestamp fields in Model base class already have `@field()` applied

**When NOT needed:**
- Public fields where field name matches schema attribute name
- Computed getters with no backing field
- Relationship fields (handled separately)

## Creating a Model

1. **Extend Model** and add `@model` decorator
2. **Add `@field()` decorator** to private backing fields with `_` prefix
3. **Override `makeObservable()`** - call `super.makeObservable()` first, then register own fields
4. **Use `observable.ref`** for single relations, `observable.shallow` for arrays
5. **Constructors can have required params and validation** - hydration bypasses constructors

### Field Initialization Rules

```typescript
@model
export class ExampleModel extends Model {
  // ✓ Optional field - may or may not have a value
  bio: string | null = null;

  // ✓ Permission-restricted field - may not be returned due to permissions
  email: string | undefined = undefined;

  // ✓ Optional AND permission-restricted field
  phoneNumber: string | null | undefined = undefined;

  // ✓ Required field with domain-specific default (WARNING: only use if explicitly intended)
  prefersDarkMode: boolean = false;

  // ✓ Required field must be initialized in constructor
  prefersWine: boolean;

  constructor(prefersWine: boolean, id?: string) {
    super(id);
    this.prefersWine = prefersWine;
    this.initTracking();
  }
}
```

**Common mistakes to avoid:**

```typescript
@model
export class BadExampleModel extends Model {
  // ✗ WRONG: Optional field without initializer - MobX won't track it
  bio?: string;

  // ✗ WRONG: Using = undefined! with public constructor
  // (only allowed with private constructor for hydration-only models)
  name: string = undefined!;

  // ✗ WRONG: Using ! without private constructor
  score!: number;

  // ✗ WRONG: Optional field using undefined instead of null
  description: string | undefined = undefined;  // Should be: string | null = null

  // ✗ WRONG: Required field not passed to constructor
  title: string;  // Will cause "not initialized" error if not set in constructor
}
```

### Model Examples

**Hydration-only model (private constructor):**
```typescript
@model
export class Account extends Model {
  // Required fields (hydration-only, private constructor allows !)
  accountId!: string;
  providerId!: string;

  // Optional fields
  accessToken: string | null = null;
  refreshToken: string | null = null;

  // Relationships
  user: $User | null = null;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      accountId: observable,
      providerId: observable,
      accessToken: observable,
      refreshToken: observable,
      user: observable.ref,
    });
  }

  private constructor(id?: string) {
    super(id);
    this.initTracking();
  }
}
```

**User-creatable model (public constructor):**
```typescript
@model
export class Post extends Model {
  // Required field (set in constructor)
  title: string;

  // Optional field
  content: string | null = null;

  // Relationships
  author: User | null = null;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      title: observable,
      content: observable,
      author: observable.ref,
    });
  }

  constructor(title: string, id?: string) {
    super(id);
    this.title = title;
    this.initTracking();
  }
}
```

### Automatic Timestamps

Model base class provides automatic timestamp management (no need to define in subclasses). All three are `Temporal.Instant` (`deletedAt: Temporal.Instant | null`) — see [Temporal types](#temporal-types). The DB columns are `DateTime @db.Timestamptz(6)`.
- `createdAt` / `updatedAt`: Set automatically on construction, `updatedAt` updates on each `save()`
- `deletedAt`: Defaults to `null`, set via `model.softDelete()` or the first phase of `model.delete()`
- MobX observables for these fields are set up via the base `makeObservable()` method

### Schema Requirements

The ZModel domain schema is the source of truth; `configureEntityMeta` walks the generated ZenStack `SchemaDef` directly. Every model needs:
- `createdAt DateTime @db.Timestamptz(6)` — required
- `updatedAt DateTime @db.Timestamptz(6)` — required
- `deletedAt DateTime? @db.Timestamptz(6)` — optional

Use `@db.Timestamptz` for every `DateTime`: plain `timestamp` columns shift by the process timezone when read through nested relations.

Relations: every relation is optional with `onDelete: SetNull`. Foreign-key scalar columns (`authorId`) are storage detail — they are hidden from models; the relation field is the model-facing link. Implicit many-to-many is supported.

Access policies go in ZModel (`@@allow`, field-level `@allow('read', …)`). A field hidden by a field-level policy hydrates as `undefined`.

### Schema Changes

1. Edit `domain.zmodel` (entities, policies). Side-specific tables go in this package's `log.zmodel` (both sides), `client.zmodel` (replica only) or `server.zmodel` (server only).
2. `bun run db:generate` — regenerates the package's typed views and both of the app's TS schemas plus the Prisma schema.
3. `bun run db:migration` — prints migration SQL from the server schema; commit it as `zenstack/server/migrations/<NNNN_name>/migration.sql` (diff from the previous schema for non-initial migrations). A migration that creates a table also sets `ALTER TABLE … REPLICA IDENTITY FULL` on it, or the server will not start.

### Inheritance Example

```typescript
import { makeObservable as mobxMakeObservable, observable } from "mobx";

// Abstract base - overrides makeObservable for ITS fields
export abstract class Invitation extends Model {
  abstract readonly modelType: string;
  status: string;
  member: Member;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      status: observable,
      member: observable.ref,
    } as any);
  }

  constructor(status: string, member: Member, id?: string) {
    super(id);
    this.status = status;
    this.member = member;
  }
}

// Concrete - overrides makeObservable for ONLY its own fields
@model
export class ChessInvitation extends Invitation {
  get modelType(): "chess" { return "chess"; }
  hasBoard: boolean;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      hasBoard: observable,  // Only this class's field
    } as any);
  }

  constructor(status: string, member: Member, hasBoard: boolean, id?: string) {
    super(status, member, id);
    this.hasBoard = hasBoard;
    this.initTracking();
  }
}
```

## Key Files

| File | Purpose |
|------|---------|
| `src/object-graph/Model.ts` | Base class for all models |
| `src/object-graph/decorators/model.ts` | `@model` decorator, inheritance handling |
| `src/object-graph/decorators/field.ts` | `@field` decorator, private field registry |
| `src/object-graph/IdentityMap.ts` | Instance caching by ID |
| `src/object-graph/persistence/ChangeTracker.ts` | Mutation tracking |
| `src/object-graph/store/RootStore.ts` | Central persistence coordinator |
| `src/object-graph/store/ModelHydrator.ts` | Raw data → model instances |
| `src/object-graph/store/EntityMeta.ts` | Schema metadata registry |
| `src/object-graph/store/ModelRegistry.ts` | Model class registry |
| `src/object-graph/columns/ColumnCodec.ts` | `ColumnCodec` (Leaf/Composite), value⟷column(s) |
| `src/object-graph/decorators/valueObject.ts` | `Field`, VO codecs, `collectAllFields` (one Field per column) |
| `src/object-graph/temporal/` | Temporal codecs, brand registry, `Temporal` re-export |

## Value Objects

Composite, equality-by-value types that compose into Models. Three storage modes, selected via `storage:` on the `@valueObject` decorator (an enum from `@upfor/sync`):

- **`ValueObjectStorage.MultiColumn`** (default): fixed-arity VOs flatten across multiple columns on the parent entity. Column names prefix from the model field name.
- **`ValueObjectStorage.SingleColumn`**: single-value wrappers (e.g. `EmailAddress`, `Slug`) store as one typed column named exactly after the parent prefix — no inner-field suffix. The VO must have exactly one `@field()` and it must be scalar (no nested VO). When used as a model field, the column is the model field's name. When nested inside another VO, the column is the parent prefix (e.g. `Contact.email: Email` nested under `User.contact` produces column `contactEmail`).
- **`ValueObjectStorage.Json`**: variable-arity VOs (lists, maps, anything with `*[]` inside) serialize to one `i.json()` column.

VOs are immutable: frozen at construction, replace-the-whole-value mutation, no in-place edits.

### Declaring a VO

```typescript
import { ValueObject, valueObject, field, ValueObjectStorage } from "@upfor/sync";

@valueObject()
export class Money extends ValueObject {
  @field() readonly amount: number;
  @field() readonly currency: string;

  constructor(amount: number, currency: string) {
    super();
    if (amount < 0) throw new Error("Money.amount must be >= 0");
    this.amount = amount;
    this.currency = currency;
    Object.freeze(this);
  }

  withAmount(amount: number): Money { return new Money(amount, this.currency); }
  withCurrency(currency: string): Money { return new Money(this.amount, currency); }
}

@valueObject({ storage: ValueObjectStorage.Json })
export class Tags extends ValueObject {
  @field() readonly items: readonly string[];

  constructor(items: readonly string[]) {
    super();
    this.items = [...items];
    Object.freeze(this);
  }
}
```

**Every VO field must be decorated with `@field()`.** The decorator is how the framework discovers a VO's field list — there is no auto-introspection. `@field()` accepts the same options on VO fields as on Model fields: `optional: true` for nullable fields, `attributeName: "..."` to remap the column suffix.

```typescript
@valueObject()
export class Price extends ValueObject {
  @field() readonly amount: number;

  @field({ optional: true })
  readonly discount: number | null;

  constructor(amount: number, discount: number | null) {
    super();
    this.amount = amount;
    this.discount = discount;
    Object.freeze(this);
  }
}
```

### Using a VO on a Model

```typescript
@model
export class Listing extends Model {
  @field({ type: Money })
  price: Money;

  @field({ type: TimeRange, optional: true })
  slot: TimeRange | null = null;

  @field({ type: Tags })
  tags: Tags;
  // ...
}
```

Value-object field nullability is declared with `@field({ optional: true })`, parallel to how nullable fields are declared inside a VO class. `price: Money` (no marker) is required and must be set in the constructor; `slot: TimeRange | null = null` is nullable because the decorator says so. The init-value (`= null`) only initializes the property at runtime; it doesn't carry the nullability signal — the decorator does.

### Declaring a singleColumn VO

For single-value wrappers (typed wrapper around one primitive — emails, slugs, handles), use `storage: ValueObjectStorage.SingleColumn`. The column is named exactly after the model field; the inner field contributes nothing to the column name. Useful when the column name is owned by an external system (e.g. an auth provider writes the `email` column) and must stay literal.

```typescript
@valueObject({ storage: ValueObjectStorage.SingleColumn })
export class EmailAddress extends ValueObject {
  @field() readonly value: string;

  constructor(value: string) {
    super();
    if (!value.trim()) throw new Error("EmailAddress cannot be empty");
    this.value = value;
    Object.freeze(this);
  }
}
```

With `email: EmailAddress` on a model, the storage column is just `email` (not `emailValue`). The framework throws at registration if a singleColumn VO has 0 or 2+ fields, or if its one field is a nested-VO field.

### Column naming (multiColumn / spread)

Prefix is the model field name, recursing through nested VOs:

| Field | Inner fields | Columns |
|---|---|---|
| `price: Money` | `amount`, `currency` | `priceAmount`, `priceCurrency` |
| `slot: TimeRange \| null` (start, end of `LocalTime`) | nested | `slotStartHour`, `slotStartMinute`, `slotEndHour`, `slotEndMinute` |
| `email: EmailAddress` (singleColumn) | `value` | `email` (inner name absorbed) |
| `tags: Tags` (JSON) | — | `tags` (single `i.json()` column) |

Inside an embedded JSON blob, keys stay bare (no prefix) — there's no flat namespace to collide in.

### Nullability rules (spread)

Evaluated independently at each VO level. A "value-object field" is nullable iff its `@field` decorator carries `optional: true`.

- All required columns set → construct the VO; optional fields may be null.
- All columns null **and** the field is nullable → the field hydrates as `null`.
- Partial column states at hydration (some required null, others set) are tolerated — the framework constructs whatever the stored data supports. Hydration trusts stored data; integrity is not re-enforced on read.

There is no runtime integrity guard. TypeScript + the frozen constructor close the loop on user code (you cannot construct a `Money` with a missing field without bypassing both the type system and the constructor), and framework decomposition correctness is covered by unit tests on the framework code itself. Optimistic-merge and partial-update paths therefore never trigger false-positive throws — they're allowed to produce intermediate partial-column states.

For an in-VO optional field (`Price.discount`), only the **required** columns count toward the "is the field set" determination; the optional column is independently nullable within an otherwise-present VO.

### Equality and cloning

- `equals(other)` is auto-generated on `ValueObject` — structural compare across registered fields, recursing into nested VOs. Override per VO for non-structural semantics.
- **No generic `with()`.** Write explicit `withX` methods per VO; route them through the constructor so invariants always run.

### Using VOs as Map / Set keys

Native `Map` and `Set` use SameValueZero (reference equality), so two structurally-equal VO instances will not collide. `ValueObject` exposes `key(): string` returning a canonical JSON form over the registered `@field()` values in declaration order:

```typescript
const groups = new Map<string, ReactionGroup>();
for (const r of reactions) {
  const k = r.emoji.key();
  const g = groups.get(k);
  if (g) g.count += 1;
  else groups.set(k, { emoji: r.emoji, count: 1 });
}
```

`toCanonical()` is the protected hook the default `key()` stringifies — override it (or `key()` directly) per VO for non-standard canonicalisation. Keys reflect `attributeName`s (the schema-facing names), not property names.

**Caveat — no class discrimination.** `key()` is a function of field *values* only. Two different VO classes with the same field shape will produce the same key. If a Map/Set may hold heterogeneous VOs, the caller is responsible for adding a discriminator (e.g. `` `${tag}:${vo.key()}` ``).

### Hydration

Same constructor-bypass rule as Models — VOs are reconstructed via `Object.create + assign + freeze`. Invariants in VO constructors run on `new` and on `withX`, not on hydration. Stored data is trusted to be valid.

### Change tracking

Every column — VO, Temporal, or plain — goes through one `Field`+codec path (`collectAllFields`): the snapshot decomposes each field to its column value(s), and `ModelSnapshotDiff` compares those. There is no separate raw-column path and no VO/Temporal awareness in `ChangeTracker`.

See [ADR 0004](../../docs/adr/0004-value-objects-in-sync.md) for the design rationale.

## Temporal types

First-class [Temporal](https://tc39.es/proposal-temporal/docs/) support. Any property (Model or VO) can declare a Temporal type; **JS `Date` is not used anywhere in the model layer** — import `Temporal` from `@upfor/sync`, never the polyfill directly.

```typescript
import { Temporal } from "@upfor/sync";

@field({ type: Temporal.Instant })
scheduledFor: Temporal.Instant;

@field({ type: Temporal.PlainDate, optional: true })
day: Temporal.PlainDate | null = null;
```

- **Declare** with `@field({ type: Temporal.X })`, same as VOs. Works on Model fields, VO fields, and nested. `optional: true` for nullable.
- **Storage**: `Instant` → `DateTime`; the plain types (`PlainDate`, `PlainDateTime`, `PlainYearMonth`, `PlainTime`, `PlainMonthDay`) → `DateTime` anchored to an instant at UTC (time-only and month-day use sentinel dates); `Duration` → `String` (ISO); `ZonedDateTime` → `DateTime` instant + `String` zone (columns `fieldInstant` + `fieldZone`). Wire form is the canonical ISO string. **Precision is milliseconds**: ZenStack returns `DateTime` as a JS `Date`, so the codecs truncate every instant to milliseconds on the way in, and `Model` stamps its timestamps with `now()` from `./temporal`, which does the same. A value a model holds is therefore the value that comes back.
- **Un-annotated `DateTime` columns default to `Temporal.Instant`** — base timestamps included. You only annotate to get a non-instant type.
- **Comparisons/sorts**: `Temporal.Instant.compare(a, b)`, `a.equals(b)`. No `.getTime()` / `.toISOString()`.
- **Local calendar** (Temporal has no implicit zone): convert via `instant.toZonedDateTimeISO(zone)`. There is no `Date`-style implicit device zone.

Internals: one codec per type (`ColumnCodec`, brand-keyed registry), the same `Field`/codec path VOs use — every column read/write goes through a codec, no special-casing.

## Design Patterns

- **Identity Map**: One instance per ID, prevents duplicates
- **Active Record + Tracking**: Models track own changes via ChangeTracker
- **Repository**: RootStore is the single entry point for persistence
- **Strategy**: Different inheritance strategies via decorator logic
- **Observer**: MobX handles reactive state propagation

## Property-Level Permissions

When a field-level access policy hides a field:

- **Type must include `undefined`**: If a property can be restricted, its type should be `T | undefined`
- **`undefined` means permission-restricted**: A value of `undefined` indicates the field was not returned due to permission rules
- **Always request all fields**: Queries that hydrate the store should request all fields of a table to ensure consistent hydration
- **Initialize with `undefined`**: Permission-restricted properties should be initialized with `undefined`

```typescript
@model
export class User extends Model {
  // Permission-restricted field - may not be returned due to permissions
  secretField: string | undefined = undefined;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      secretField: observable,
    } as any);
  }
}
```

Always run tests if you made relevant changes to sync package
