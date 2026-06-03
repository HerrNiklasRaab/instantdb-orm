# Sync Package - Architecture Guide

A typed, reactive ORM for InstantDB with MobX-powered change tracking.

## Overview

This package bridges domain models and InstantDB (a real-time database). Key characteristics:
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
- `save(model)` - Persists tracked changes to InstantDB
- `delete(model)` - Soft-deletes with relationship cleanup
- `queryModel(EntityClass)` - Fetches and hydrates entities
- `subscribeModel(EntityClass, callback)` - Live subscriptions

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
Reconstructs model instances from raw InstantDB data. Hydration bypasses constructors, so constructors can have required parameters, validation, and business logic.

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

@model("$users")
export class $User extends Model { ... }
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

Model base class provides automatic timestamp management (no need to define in subclasses). All three are `Temporal.Instant` (`deletedAt: Temporal.Instant | null`) — see [Temporal types](#temporal-types). The DB columns stay `i.date()`.
- `createdAt` / `updatedAt`: Set automatically on construction, `updatedAt` updates on each `save()`
- `deletedAt`: Defaults to `null`, set via `store.delete(entity)`
- MobX observables for these fields are set up via the base `makeObservable()` method

### Schema Requirements

Every entity in the schema must have these timestamp fields with specific optionality:

**Regular entities:**
- `createdAt`: **required** (not optional)
- `updatedAt`: **required** (not optional)
- `deletedAt`: **optional**

**System entities (prefixed with `$`):**
- `createdAt`: **optional** (must be optional)
- `updatedAt`: **optional** (must be optional)
- `deletedAt`: **optional** (must be optional)

System entities like `$users` and `$files` are managed externally (e.g., by InstantDB auth) and may not always have timestamps set.

Example (regular entity):
```typescript
users: i.entity({
  name: i.string(),
  createdAt: i.date().indexed(),      // required (no .optional())
  updatedAt: i.date().indexed(),      // required (no .optional())
  deletedAt: i.date().indexed().optional(), // must be optional
}),
```

Example (system entity):
```typescript
$users: i.entity({
  email: i.string().unique().indexed(),
  createdAt: i.date().indexed().optional(),  // must be optional for system entities
  updatedAt: i.date().indexed().optional(),  // must be optional for system entities
  deletedAt: i.date().indexed().optional(),  // must be optional for system entities
}),
```

### Schema Changes

When adding fields to models, also update `packages/bl/src/instant.schema.ts` and push:
```bash
infisical run --env=dev -- bash -c 'npx instant-cli@latest push schema -p admin -a "$INSTANTDB_APP_ID" -y'
```

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
- **Storage** (DB column stays a normal InstantDB type): `Instant` / `PlainDate` / `PlainDateTime` / `PlainYearMonth` → `i.date()`; `PlainTime` / `PlainMonthDay` → `i.date()` (anchored to a sentinel instant for DB ordering); `Duration` → `i.string()` (ISO); `ZonedDateTime` → `i.date()` instant + `i.string()` zone (columns `fieldInstant` + `fieldZone`). Wire form is the canonical ISO string; **full precision preserved** (no ms floor).
- **Un-annotated `i.date()` columns default to `Temporal.Instant`** — base timestamps included. You only annotate to get a non-instant type.
- **Comparisons/sorts**: `Temporal.Instant.compare(a, b)`, `a.equals(b)`. No `.getTime()` / `.toISOString()`.
- **Local calendar** (Temporal has no implicit zone): convert via `instant.toZonedDateTimeISO(zone)`. There is no `Date`-style implicit device zone.

Internals: one codec per type (`ColumnCodec`, brand-keyed registry), the same `Field`/codec path VOs use — every column read/write goes through a codec, no special-casing. See [ADR 0005](../../docs/adr/0005-temporal-types-in-sync.md).

## Design Patterns

- **Identity Map**: One instance per ID, prevents duplicates
- **Active Record + Tracking**: Models track own changes via ChangeTracker
- **Repository**: RootStore is the single entry point for persistence
- **Strategy**: Different inheritance strategies via decorator logic
- **Observer**: MobX handles reactive state propagation

## Property-Level Permissions

When InstantDB property permissions restrict access to a field:

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

