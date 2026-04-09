import { observable, action, makeObservable } from "mobx";
import type { Model } from "./Model";

export class IdentityMap<T extends Model> {
  private cache: Map<string, T> = new Map();
  private onModelAddedListeners = new Set<(model: T) => void>();

  constructor() {
    makeObservable<IdentityMap<T>, "cache">(this, {
      cache: observable.shallow,
      set: action,
      delete: action,
      clear: action,
    });
  }

  addOnModelAdded(callback: (model: T) => void): void {
    this.onModelAddedListeners.add(callback);
  }

  removeOnModelAdded(callback: (model: T) => void): void {
    this.onModelAddedListeners.delete(callback);
  }

  get(id: string): T | undefined {
    return this.cache.get(id);
  }

  has(id: string): boolean {
    return this.cache.has(id);
  }

  set(model: T): T {
    const isNew = !this.cache.has(model.id);
    this.cache.set(model.id, model);
    if (isNew) {
      for (const listener of this.onModelAddedListeners) {
        listener(model);
      }
    }
    return model;
  }

  getOrCreate(id: string, factory: () => T): T {
    const existing = this.cache.get(id);
    if (existing) {
      return existing;
    }
    const model = factory();
    this.cache.set(id, model);
    for (const listener of this.onModelAddedListeners) {
      listener(model);
    }
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
