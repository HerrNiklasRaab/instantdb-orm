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

@model
export class User extends Model {
  private _name: string = undefined!;  // Initializer required for MobX

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      _name: observable,
    } as any);
  }

  constructor(data: { id?: string; name: string }) {
    super({ id: data.id });
    this._name = data.name;
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
- `type` getter returning a literal string discriminator

```typescript
// Abstract base - NO @model
export abstract class MatchRequest extends Model {
  abstract readonly type: string;  // Discriminator field
  // shared fields...
}

// Concrete - HAS @model + type getter
@model
export class ChessMatchRequest extends MatchRequest {
  get type(): "chess" { return "chess"; }  // Determines table storage
  // chess-specific fields...
}

@model
export class SkiMatchRequest extends MatchRequest {
  get type(): "ski" { return "ski"; }
}
```

Both store in `matchRequests` table with `type` column distinguishing them.

### Multi-Table Inheritance (MTI)
Each concrete class gets its own database table. Use when subclasses have very different fields.

**Requirements:**
- Abstract base class (no `@model`)
- Concrete subclasses with `@model` decorator
- **No** `type` getter

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

## Creating a Model

1. **Extend Model** and add `@model` decorator
2. **Override `makeObservable()`** - call `super.makeObservable()` first, then register own fields
3. **Use `observable.ref`** for single relations, `observable.shallow` for arrays
4. **Constructors can have required params and validation** - hydration bypasses constructors

```typescript
import { makeObservable as mobxMakeObservable, observable } from "mobx";

@model
export class Post extends Model {
  title: string = undefined!;        // Required - must be passed via constructor
  description?: string = undefined;  // Optional - can be set later

  // Relations
  author: User | null = null;
  comments: Comment[] = [];

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      title: observable,
      description: observable,
      author: observable.ref,        // Single reference
      comments: observable.shallow,  // Array of references
    });
  }

  constructor(data: { id?: string; title: string }) {
    super({ id: data.id });
    this.title = data.title;         // Required field initialized here
    this.initTracking();
  }
}
```

### Inheritance Example

```typescript
import { makeObservable as mobxMakeObservable, observable } from "mobx";

// Abstract base - overrides makeObservable for ITS fields
export abstract class MatchRequest extends Model {
  abstract readonly type: string;
  status: string = undefined!;
  member: Member = undefined!;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      status: observable,
      member: observable.ref,
    } as any);
  }

  constructor(data: { id?: string; status: string; member: Member }) {
    super({ id: data.id });
    this.status = data.status;
    this.member = data.member;
  }
}

// Concrete - overrides makeObservable for ONLY its own fields
@model
export class ChessMatchRequest extends MatchRequest {
  get type(): "chess" { return "chess"; }
  hasBoard: boolean = undefined!;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      hasBoard: observable,  // Only this class's field
    } as any);
  }

  constructor(data: { ...; hasBoard: boolean }) {
    super(data);
    this.hasBoard = data.hasBoard;
    this.initTracking();
  }
}
```

## Key Files

| File | Purpose |
|------|---------|
| `src/object-graph/Model.ts` | Base class for all models |
| `src/object-graph/decorators/model.ts` | `@model` decorator, inheritance handling |
| `src/object-graph/IdentityMap.ts` | Instance caching by ID |
| `src/object-graph/persistence/ChangeTracker.ts` | Mutation tracking |
| `src/object-graph/store/RootStore.ts` | Central persistence coordinator |
| `src/object-graph/store/ModelHydrator.ts` | Raw data → model instances |
| `src/object-graph/store/EntityMeta.ts` | Schema metadata registry |
| `src/object-graph/store/ModelRegistry.ts` | Model class registry |

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

