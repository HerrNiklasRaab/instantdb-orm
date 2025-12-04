import type { Model } from "../Model";
import type { ModelConstructor } from "./types";

// Re-export metadata from EntityMeta
export {
  type EntityName,
  type EntityMeta,
  type RelationshipFieldMeta,
  getEntityMeta,
  getEntityNames,
  isValidEntityName,
  configureEntityMeta,
  type SchemaConfig,
} from "./EntityMeta";

// Mutable registry - populated by @model decorator
const MODEL_REGISTRY: Map<string, ModelConstructor<Model>> = new Map();

// STI discriminator registry: entityName -> Map<discriminatorValue, ConcreteClass>
const DISCRIMINATOR_REGISTRY: Map<
  string,
  Map<string, ModelConstructor<Model>>
> = new Map();

export function registerDiscriminator(
  entityName: string,
  discriminatorValue: string,
  ModelClass: ModelConstructor<Model>
): void {
  let discriminatorMap = DISCRIMINATOR_REGISTRY.get(entityName);
  if (!discriminatorMap) {
    discriminatorMap = new Map();
    DISCRIMINATOR_REGISTRY.set(entityName, discriminatorMap);
  }
  discriminatorMap.set(discriminatorValue, ModelClass);
}

export function getModelClassForDiscriminator(
  entityName: string,
  discriminatorValue: string
): ModelConstructor<Model> | undefined {
  return DISCRIMINATOR_REGISTRY.get(entityName)?.get(discriminatorValue);
}

export function hasDiscriminatorMapping(entityName: string): boolean {
  const map = DISCRIMINATOR_REGISTRY.get(entityName);
  return map !== undefined && map.size > 0;
}

export function getModelClass(entityName: string): ModelConstructor<Model> {
  const ModelClass = MODEL_REGISTRY.get(entityName);
  if (ModelClass) {
    return ModelClass;
  }

  // For STI entities, return the first registered subclass as default
  // (actual instantiation will use resolveModelClass which checks discriminator)
  const discriminatorMap = DISCRIMINATOR_REGISTRY.get(entityName);
  if (discriminatorMap && discriminatorMap.size > 0) {
    const firstClass = discriminatorMap.values().next().value;
    if (firstClass) return firstClass;
  }

  throw new Error(
    `Unknown entity type: ${entityName}. Did you add @model decorator to the model class?`
  );
}

export function getRegisteredModelNames(): string[] {
  return Array.from(MODEL_REGISTRY.keys());
}

export function isRegisteredModel(name: string): boolean {
  return MODEL_REGISTRY.has(name);
}

// Exported for @model decorator
export { MODEL_REGISTRY };

// Generic type helpers
export type ModelInstanceFor<_K extends string> = Model;
export type ModelClassFor<_K extends string> = ModelConstructor<Model>;
