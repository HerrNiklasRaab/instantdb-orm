# A Linear-like sync API on top of InstantDB

Since installing Linear for the first time, I was in awe of their sync engine. Not even necessarily for the user-facing benefits — real-time sync, everything loading instantly — but for the insane simplification on the developer experience side. No API juggling, no model mapping between the view, the business logic, and the data layer.

I dug through countless libraries and products and finally landed on [InstantDB](https://instantdb.com), probably the best backend of this new era of sync.

What they built is amazing, and a real step up. But it didn't provide the API I'd want as someone familiar with Domain Driven Design.

So I built it:

---

## What you get

**🌍 One codebase for server and client.** The same model classes, the same methods, the same validation — running in your backend, your web app, and your mobile app. Write a rule once and it's enforced everywhere.

**🧪 Integration tests become unit tests.** Swap one line and the in-memory client gives you a *real* `RootStore` — real change tracking, real hydration, real relationships — with no network and no database. Logic that used to need a provisioned test app and a slow, flaky integration suite is now a plain unit test that runs in milliseconds.

**🏛️ A real domain model, not data bags.** Entities are classes with methods and rules — `invitation.accept()`, `party.activeMembers` — validated in the constructor, private by default. Business logic lives in one place instead of being re-implemented in every component that touches the data, and an entity in an invalid state can't reach your UI.

**📡 Your domain model is your view model.** Bind components straight to your entities — no DTOs, no view models, no mapping layer to keep in sync. Change an object and the UI reading it updates itself, down to the individual property.

**📥 Load a slice, not the database.** The choice used to be fetch-per-screen or sync everything — a round trip on every navigation, or a client that chokes as history grows. Here you pick the slice: the last 100 messages of one chat hydrate into the same object graph, with the same classes, methods, and reactivity as a full sync. Startup stays fast however much history exists.

**⚡ Just edit your models.** Set properties, push to arrays, reassign relationships — plain object code. The ORM tracks what you changed and builds the transaction for you. You never write an update statement, diff anything by hand, or juggle IDs.

**🔀 Property-level sync, not row-level.** Only the fields you actually touched are written, so two people editing different properties of the same entity don't overwrite each other. Incoming updates merge the same way — field by field, skipping anything the user is currently editing, so a sync can't wipe out what someone is typing.

**✏️ Roll back transactions — edit forms without draft copies.** Let the user edit the real object, then keep it or throw the edits away. No cloned form state, no `{...entity}` spread, no merging a draft back into the real thing.

**📝 In-memory fields — no separate state for temporary edits.** Transient state usually lands somewhere awkward: `useState` that dies when a virtualized row unmounts, or a `Map<chatId, string>` you thread through props and clean up by hand. `@inMemory` puts it on the entity instead — `chat.draftText` follows the chat and vanishes with it.

**🕰️ Automatic `createdAt` / `updatedAt` tracking.**

**🗑️ Soft delete, built in.** Deleted entities vanish from every query automatically: no `deletedAt` filter to remember, no removed item reappearing in a list. `delete()` marks the row before removing it, so a failed delete leaves it invisible rather than half-gone — and `softDelete()` keeps the tombstone when you need the history.

**🧬 Real inheritance — single-table or multi-table.** `CardPayment` and `BankTransfer` share `refund()` and `amount` while keeping their own fields. Store the hierarchy in one table or one table per subclass — your domain code is identical either way.

**💎 Value objects that store themselves.** Model `Money`, `TimeRange`, or `EmailAddress` as immutable types compared by value, then declare `price: Money` and let the ORM handle storage — no serializing by hand, no `priceAmount` / `priceCurrency` bookkeeping leaking into your model. The type validates itself, so a negative price or a malformed email can't exist in the first place.

**📅 Dates that mean what they say.** Store a [Temporal](https://tc39.es/proposal-temporal/docs/) `Instant`, `PlainDate`, `ZonedDateTime`, or `Duration` straight on a model. A birthday stays a calendar date instead of shifting a day when the user crosses a timezone, and a moment keeps full precision instead of being rounded to milliseconds. No `getTime()` arithmetic anywhere.

**🧩 Any type can be a column.** Your domain isn't limited to what the database understands. Teach the ORM how to store a `Decimal`, a `Color`, a branded ID, or any type from a library — once — and use it as a field type anywhere. Temporal support is built exactly this way.

**⏱️ Immediate or eventual consistency — your choice, per change.** Some things must land together: those go in one transaction. Others only have to happen eventually — the confirmation email, the cleanup, the downstream update. Model both with the same objects and decide per change which one it is.

**📮 Built-in event pipeline.** Write an event in the same transaction as the change that caused it, and a handler picks it up and runs it — dispatched by event type, retried on restart. The transactional outbox pattern with no broker, no queue, no extra infrastructure.

**🔍 Fully typed.** Queries, relationships, and attributes are checked against your InstantDB schema. Rename a column and TypeScript tells you what broke.

**🛡️ Permission-aware.** Property-level permissions are modeled honestly: a restricted field is `undefined`, distinct from a genuinely absent `null`.

**🤖 Loved by coding agents.** Agents scatter and duplicate business logic all over the codebase, because they don't know where to put it. Now it's all in one place. And loading that context is cheap — it's condensed into the model instead of spread across every file that touches the data.

---

## Examples

### 🌍 One codebase for server and client

Construct a different adapter; everything above it is identical.

```ts
// server
const store = new RootStore({ db: new InstantDBAdminAdapter(adminDb) });

// client
const store = new RootStore({ db: new InstantDBClientAdapter(db) });

// same call, both places
await store.transaction(() => { invitation.accept(); });
```

### 🧪 Integration tests become unit tests

```ts
const store = new RootStore<AppSchema>({
  db: new InMemoryInstantDBSyncClient<AppSchema>({ schema }),
});
store.subscribeAll();
```

That's the whole setup — no test app to provision, no credentials, no teardown. And it isn't a mock: change tracking, hydration, relationship wiring, and the transaction lifecycle are the real implementations, with only storage swapped.

### 🏛️ A real domain model, not data bags

```ts
@model("parties")
export class Party extends Model {
  @field()
  private _name: string;

  members: Member[] = [];

  constructor(name: string, id?: string) {
    super(id);
    if (!name.trim()) throw new Error("Party name cannot be empty");
    this._name = name;
    this.initTracking();
  }

  get name(): string { return this._name; }

  get activeMembers(): Member[] {
    return this.members.filter(m => m.isActive);
  }

  rename(name: string): void {
    if (!name.trim()) throw new Error("Party name cannot be empty");
    this._name = name;
  }
}
```

### 📡 Your domain model is your view model

```tsx
const PartyRow = observer(({ party }: { party: Party }) => (
  <Text>{party.name} · {party.activeMembers.length} going</Text>
));
```

No mapping step in between — the component reads the entity directly.

### 📥 Load a slice, not the database

```ts
await store.subscribeQuery({
  messages: {
    $: { where: { chatId }, order: { createdAt: "desc" }, limit: 100 },
  },
});

store.getAll(Message);   // the hydrated slice — live, typed, full behavior
```

Query as narrowly as you like; whatever comes back becomes real models in the same graph.

### ⚡ Just edit your models

```ts
await store.transaction(() => {
  invitation.accept();
  party.addMember(member);
});
```

### 🔀 Property-level sync, not row-level

```ts
// one client
await store.transaction(() => { post.title = "New title"; });

// another client, at the same time
await store.transaction(() => { post.body = "New body"; });
```

Both land. Only the touched field goes over the wire, and neither write carries the other's stale value.

### ✏️ Roll back transactions — edit forms without draft copies

```ts
const draft = store.createTransaction();
draft.run(() => { party.rename(input); });

await draft.commit();   // Save
draft.rollback();       // Cancel — every edited field back where it was
```

### 📝 In-memory fields — no separate state for temporary edits

```ts
@model("chats")
export class Chat extends Model {
  @field()
  private _title: string;

  @inMemory("")
  draftText: string = "";      // never persisted
}
```

```tsx
<TextInput
  value={chat.draftText}
  onChangeText={text => { chat.draftText = text; }}
/>
```

The draft rides along with the chat object, so it's still there when the user navigates away and back — and no transaction is needed, because nothing is being saved.

### 🕰️ Automatic `createdAt` / `updatedAt` tracking

```ts
post.createdAt;   // Temporal.Instant, set on construction
post.updatedAt;   // bumped on every save
```

You never declare these.

### 🗑️ Soft delete, built in

```ts
await store.transaction(() => { post.softDelete(); });  // keep the tombstone

await store.queryModel(Post);  // deleted posts already excluded
```

### 🧬 Real inheritance — single-table or multi-table

```ts
export abstract class Payment extends Model {
  abstract readonly modelType: string;

  @field({ type: Money })
  amount: Money;

  refund(): void { /* shared by every subclass */ }
}

@model("payments")
export class CardPayment extends Payment {
  get modelType(): "card" { return "card"; }
  last4: string = "";
}

@model("payments")
export class BankTransfer extends Payment {
  get modelType(): "transfer" { return "transfer"; }
  iban: string = "";
}
```

Both live in the `payments` table, told apart by `modelType`. Drop the discriminator and each subclass gets its own table instead — the domain code is unchanged.

### 💎 Value objects that store themselves

```ts
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
}
```

```ts
@field({ type: Money })
price: Money;              // → columns priceAmount, priceCurrency
```

### 📅 Dates that mean what they say

```ts
@field({ type: Temporal.PlainDate })
birthday: Temporal.PlainDate;      // a calendar date, not an instant

@field({ type: Temporal.Instant })
scheduledFor: Temporal.Instant;
```

### 🧩 Any type can be a column

```ts
class ColorCodec extends ColumnCodec<Color> { /* to/from column value */ }
registerColumnCodec(Color, new ColorCodec());

@field({ type: Color })
accent: Color;
```

### ⏱️ Immediate or eventual consistency — your choice, per change

```ts
await store.transaction(() => {
  order.markPaid();          // immediate — these two land together, or neither does
  inventory.reserve(order.items);

  new OrderPaid(order);      // eventual — committed now, handled later
});
```

### 📮 Built-in event pipeline

```ts
class SendReceipt implements EventPipelineHandler {
  async handle(event: OrderPaid, ctx: EventPipelineContext) {
    await email.sendReceipt(event.order);   // throws → stays pending, runs again
  }
}

new EventPipeline(store, [
  { EventClass: OrderPaid, handler: new SendReceipt() },
]).start();
```

Write the work, not the plumbing. No queue to provision, no broker to run, no outbox table to reconcile — the event is a row that was already committed with the change that caused it.

### 🔍 Fully typed

```ts
const parties = await store.queryModel(Party);   // Party[], checked against your schema
```

### 🛡️ Permission-aware

```ts
email: string | undefined = undefined;   // undefined → hidden by permissions
bio: string | null = null;               // null → genuinely empty
```
