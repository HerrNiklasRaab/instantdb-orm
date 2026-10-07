import type { ZenStackModels } from "./DatabaseClient";
import type { ClientContract } from "@zenstackhq/orm";
import type { SchemaType as ServerSchema } from "./generated/server/schema";
import { hasModels } from "./logClient";

/** A ZenStack client seen through the server-only models (`server.zmodel`). */
export type ServerClient = ClientContract<ServerSchema>;

function isServerClient(value: ZenStackModels): value is ServerClient {
  return hasModels(value, ["bucketLog"]);
}

export function serverClientOf(client: ZenStackModels): ServerClient {
  if (!isServerClient(client)) {
    throw new Error("The ZenStack client lacks the server's models — does the server schema import @upfor/sync's server.zmodel?");
  }
  return client;
}
