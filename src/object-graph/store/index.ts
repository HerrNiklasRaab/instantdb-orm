export { RootStore } from "./RootStore";
export {
  ModelRegistry,
  modelRegistry,
  getModelClass,
  getModelClassForDiscriminator,
  hasDiscriminatorMapping,
  getRegisteredModelNames,
  isRegisteredModel,
} from "./ModelRegistry";
export {
  getEntityMeta,
  getEntityNames,
  isValidEntityName,
  configureEntityMeta,
  type EntityMeta,
  type EntityName,
  type RelationshipFieldMeta,
} from "./EntityMeta";
export { ModelHydrator, type GetIdentityMap } from "./ModelHydrator";
export type {
  RawEntityData,
  QueryResult,
  RootStoreConfig,
  InstantDBClient,
  ModelConstructor,
  ModelInstanceFor,
  ModelClassFor,
} from "./types";
