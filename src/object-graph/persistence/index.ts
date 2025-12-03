export { setDatabase, getDatabase } from "./DatabaseProvider";
export { ChangeTracker, type TrackedChanges } from "./ChangeTracker";
export {
  initializeTracking,
  saveEntity,
  getTracker,
} from "./EntityPersistence";
export type { InstantDBClient, TxChunk } from "./types";
