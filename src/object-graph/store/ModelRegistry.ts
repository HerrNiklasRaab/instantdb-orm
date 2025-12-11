import type { Model } from "../Model";
import type { ModelConstructor } from "./types";

/**
 * Singleton registry for Model classes.
 * Populated by @model decorator at class definition time.
 */
export class ModelRegistry {
  private static instance: ModelRegistry;

  private models = new Map<string, ModelConstructor<Model>>();
  private discriminators = new Map<string, Map<string, ModelConstructor<Model>>>();
  private baseClassToSubclasses = new Map<Function, Set<ModelConstructor<Model>>>();

  private constructor() {}

  static getInstance(): ModelRegistry {
    if (!ModelRegistry.instance) {
      ModelRegistry.instance = new ModelRegistry();
    }
    return ModelRegistry.instance;
  }

  /**
   * Register a model class for an entity name.
   * Called by @model decorator.
   */
  register(entityName: string, ModelClass: ModelConstructor<Model>): void {
    this.models.set(entityName, ModelClass);
  }

  /**
   * Register a discriminator mapping for STI (Single Table Inheritance).
   * Called by @model decorator for subclasses.
   */
  registerDiscriminator(
    entityName: string,
    discriminatorValue: string,
    ModelClass: ModelConstructor<Model>
  ): void {
    let discriminatorMap = this.discriminators.get(entityName);
    if (!discriminatorMap) {
      discriminatorMap = new Map();
      this.discriminators.set(entityName, discriminatorMap);
    }
    discriminatorMap.set(discriminatorValue, ModelClass);
  }

  /**
   * Register a subclass for a base class (for polymorphic getAll).
   * Called by @model decorator when decorating subclasses.
   */
  registerSubclass(
    BaseClass: Function,
    SubClass: ModelConstructor<Model>
  ): void {
    let subclasses = this.baseClassToSubclasses.get(BaseClass);
    if (!subclasses) {
      subclasses = new Set();
      this.baseClassToSubclasses.set(BaseClass, subclasses);
    }
    subclasses.add(SubClass);
  }

  /**
   * Get all registered subclasses for a base class.
   * Used by RootStore.getAll for polymorphic queries.
   */
  getSubclasses(BaseClass: Function): ModelConstructor<Model>[] {
    return Array.from(this.baseClassToSubclasses.get(BaseClass) ?? []);
  }

  /**
   * Get the model class for an entity name.
   * For STI entities without a base class registered, returns the first subclass.
   */
  getModelClass(entityName: string): ModelConstructor<Model> {
    const ModelClass = this.models.get(entityName);
    if (ModelClass) {
      return ModelClass;
    }

    // For STI entities, return the first registered subclass as default
    // (actual instantiation will use resolveModelClass which checks discriminator)
    const discriminatorMap = this.discriminators.get(entityName);
    if (discriminatorMap && discriminatorMap.size > 0) {
      const firstClass = discriminatorMap.values().next().value;
      if (firstClass) return firstClass;
    }

    throw new Error(
      `Unknown entity type: ${entityName}. Did you add @model decorator to the model class?`
    );
  }

  /**
   * Get a model class for a specific discriminator value (STI).
   */
  getModelClassForDiscriminator(
    entityName: string,
    discriminatorValue: string
  ): ModelConstructor<Model> | undefined {
    return this.discriminators.get(entityName)?.get(discriminatorValue);
  }

  /**
   * Check if an entity has discriminator mappings (uses STI).
   */
  hasDiscriminatorMapping(entityName: string): boolean {
    const map = this.discriminators.get(entityName);
    return map !== undefined && map.size > 0;
  }

  /**
   * Get all registered model names.
   */
  getRegisteredNames(): string[] {
    return Array.from(this.models.keys());
  }

  /**
   * Check if a model is registered for an entity name.
   */
  isRegistered(name: string): boolean {
    return this.models.has(name);
  }

  /**
   * Clear all registrations.
   * Useful for testing.
   */
  clear(): void {
    this.models.clear();
    this.discriminators.clear();
    this.baseClassToSubclasses.clear();
  }
}

// Convenience export for singleton access
export const modelRegistry = ModelRegistry.getInstance();

// Convenience functions that delegate to modelRegistry singleton
export function getModelClass(entityName: string): ModelConstructor<Model> {
  return modelRegistry.getModelClass(entityName);
}

export function getModelClassForDiscriminator(
  entityName: string,
  discriminatorValue: string
): ModelConstructor<Model> | undefined {
  return modelRegistry.getModelClassForDiscriminator(entityName, discriminatorValue);
}

export function hasDiscriminatorMapping(entityName: string): boolean {
  return modelRegistry.hasDiscriminatorMapping(entityName);
}

export function getRegisteredModelNames(): string[] {
  return modelRegistry.getRegisteredNames();
}

export function isRegisteredModel(name: string): boolean {
  return modelRegistry.isRegistered(name);
}

export function getSubclasses(BaseClass: Function): ModelConstructor<Model>[] {
  return modelRegistry.getSubclasses(BaseClass);
}
