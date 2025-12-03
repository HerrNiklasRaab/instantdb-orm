import type { InstantDBClient } from "./types";

let dbInstance: InstantDBClient | null = null;

export function setDatabase(db: InstantDBClient): void {
  dbInstance = db;
}

export function getDatabase(): InstantDBClient {
  if (!dbInstance) {
    throw new Error(
      "Database not initialized. Call setDatabase() before using entity save()."
    );
  }
  return dbInstance;
}
