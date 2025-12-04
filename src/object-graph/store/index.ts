export { RootStore } from "./RootStore";
export {
  MODEL_REGISTRY,
  getModelClass,
  isValidEntityName,
  getEntityNames,
  getRegisteredModelNames,
  isRegisteredModel,
  configureEntityMeta,
  type SchemaConfig,
  type EntityName,
  type ModelInstanceFor,
  type ModelClassFor,
} from "./EntityRegistry";
export { EntityHydrator, type GetIdentityMap } from "./EntityHydrator";
export type {
  RawEntityData,
  QueryResult,
  RootStoreConfig,
  InstantDBClient,
  ModelConstructor,
} from "./types";
