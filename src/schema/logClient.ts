import type { ZenStackModels } from "./DatabaseClient";
import type { ClientContract } from "@zenstackhq/orm";
import type { SchemaType as LogSchema } from "./generated/log/schema";

/** A ZenStack client seen through the shared log models (`log.zmodel`). */
export type LogClient = ClientContract<LogSchema>;

export function hasModels(client: ZenStackModels, models: readonly string[]): boolean {
  return models.every((model) => {
    const delegate: unknown = Reflect.get(client, model);
    return typeof delegate === "object" && delegate !== null && typeof Reflect.get(delegate, "findMany") === "function";
  });
}

function isLogClient(value: ZenStackModels): value is LogClient {
  return hasModels(value, ["transactions", "changes"]);
}

/**
 * Any ZenStack client built from a schema that imports `log.zmodel` carries
 * these models; the shape check is what stands in for a compile-time link
 * between the app's schema and the package's.
 */
export function logClientOf(client: ZenStackModels): LogClient {
  if (!isLogClient(client)) {
    throw new Error("The ZenStack client lacks the sync log models — does the schema import @upfor/sync's log.zmodel?");
  }
  return client;
}
