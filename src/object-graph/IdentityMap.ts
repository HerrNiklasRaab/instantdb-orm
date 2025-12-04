import { observable, action, makeObservable } from "mobx";
import type { Model } from "./Model";

// Interface for models that can be tracked (minimal interface for persistence)
export interface IModel {
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

  set(model: T): T {
    this.cache.set(model.id, model);
    return model;
  }

  getOrCreate(id: string, factory: () => T): T {
    const existing = this.cache.get(id);
    if (existing) {
      return existing;
    }
    const model = factory();
    this.cache.set(id, model);
    return model;
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
