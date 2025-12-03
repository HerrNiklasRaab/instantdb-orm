export { RootStore } from "./RootStore";
export {
  ENTITY_REGISTRY,
  getEntityClass,
  isValidEntityName,
  getEntityNames,
  getRegisteredEntityNames,
  isRegisteredEntity,
  configureEntityMeta,
  type SchemaConfig,
  type EntityName,
  type EntityInstanceFor,
  type EntityClassFor,
} from "./EntityRegistry";
export { EntityHydrator, type GetIdentityMap } from "./EntityHydrator";
export type {
  RawEntityData,
  QueryResult,
  RootStoreConfig,
  InstantDBClient,
  EntityConstructor,
} from "./types";
