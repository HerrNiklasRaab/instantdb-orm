export { IdentityMap } from "./IdentityMap";
export { Model } from "./Model";
export {
  RootStore,
  EntityHydrator,
  ENTITY_REGISTRY,
  getEntityClass,
  isValidEntityName,
  getEntityNames,
  // Configuration functions
  configureEntityMeta,
  registerEntity,
  registerEntities,
  createEntityRegistry,
  type SchemaConfig,
  type EntityName,
  type EntityInstanceFor,
  type EntityClassFor,
  type RawEntityData,
  type QueryResult,
  type RootStoreConfig,
  type EntityConstructor,
  type GetIdentityMap,
} from "./store";
export {
  setDatabase,
  getDatabase,
  initializeTracking,
  type InstantDBClient,
} from "./persistence";
