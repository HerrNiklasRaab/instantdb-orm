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
  getEntityAttrs,
  getEntityLinks,
  getEntityNames,
  isValidEntityName,
  configureEntityMeta,
  findReverseSide,
  type EntityName,
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
