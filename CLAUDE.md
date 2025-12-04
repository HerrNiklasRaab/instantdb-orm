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
2. Define `id: string` and `deletedAt: Date | null`
3. Call `this.init(annotations)` in constructor to set up MobX

```typescript
@model
export class User extends Model {
  readonly id: string;
  private _name: string;
  deletedAt: Date | null = null;

  constructor(id: string, data: { name: string }) {
    super();
    this.id = id;
    this._name = data.name;
    this.init({
      _name: observable,
      deletedAt: observable,
    });
  }

  get name() { return this._name; }
  set name(v: string) { this._name = v; }
}
```

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
Reconstructs model instances from raw InstantDB data:
1. Resolves correct class (using discriminator for STI)
2. Creates/updates instance via identity map
3. Sets up bidirectional relationships
4. Marks as persisted (not new)

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
3. **Call `init()`** with MobX annotations in constructor
4. **Use `observable.ref`** for single relations, `observable.shallow` for arrays

```typescript
@model
export class Post extends Model {
  readonly id: string;
  private _title: string;
  deletedAt: Date | null = null;

  // Relations
  author: User | null = null;
  comments: Comment[] = [];

  constructor(id: string, data: { title: string }) {
    super();
    this.id = id;
    this._title = data.title;
    this.init({
      _title: observable,
      deletedAt: observable,
      author: observable.ref,      // Single reference
      comments: observable.shallow, // Array of references
    });
  }

  get title() { return this._title; }
  set title(v: string) { this._title = v; }
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

