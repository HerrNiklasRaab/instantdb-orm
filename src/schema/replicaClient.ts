import type { ZenStackModels } from "./DatabaseClient";
import type { ClientContract } from "@zenstackhq/orm";
import type { SchemaType as ReplicaSchema } from "./generated/client/schema";
import { hasModels } from "./logClient";

/** A ZenStack client seen through the client-only models (`client.zmodel`). */
export type ReplicaClient = ClientContract<ReplicaSchema>;

function isReplicaClient(value: ZenStackModels): value is ReplicaClient {
  return hasModels(value, ["hiddenFields", "bucketCursors"]);
}

export function replicaClientOf(client: ZenStackModels): ReplicaClient {
  if (!isReplicaClient(client)) {
    throw new Error("The ZenStack client lacks the replica's models — does the client schema import @upfor/sync's client.zmodel?");
  }
  return client;
}
