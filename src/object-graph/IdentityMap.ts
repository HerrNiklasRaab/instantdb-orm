import { observable, action, makeObservable } from "mobx";
import type { Model } from "./Model";

// Interface for entities that can be tracked (minimal interface for persistence)
export interface IEntity {
  readonly id: string;
}

export class IdentityMap<T extends Model> {
  private cache: Map<string, T> = new Map();

  constructor() {
    makeObservable<IdentityMap<T>, "cache">(this, {
      cache: observable.shallow,
      set: action,
      delete: action,
      clear: action,
    });
  }

  get(id: string): T | undefined {
    return this.cache.get(id);
  }

  has(id: string): boolean {
    return this.cache.has(id);
  }

  set(entity: T): T {
    this.cache.set(entity.id, entity);
    return entity;
  }

  getOrCreate(id: string, factory: () => T): T {
    const existing = this.cache.get(id);
    if (existing) {
      return existing;
    }
    const entity = factory();
    this.cache.set(id, entity);
    return entity;
  }

  delete(id: string): boolean {
    return this.cache.delete(id);
  }

  clear(): void {
    this.cache.clear();
  }

  values(): T[] {
    return Array.from(this.cache.values());
  }

  get size(): number {
    return this.cache.size;
  }
}
