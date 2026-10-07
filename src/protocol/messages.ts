import type { JsonValue } from "@zenstackhq/orm";
import { z } from "zod";
import type { BucketKeyJson } from "../buckets/BucketKey";
import type { ColumnValue } from "../object-graph/columns/types";
import type { Change, TransactionEffect, TransactionStatus } from "../transactions";
import type { QueryResult, UntypedQuery } from "../queries";

// Only the envelope is checked here: ZenStack validates the findMany
// arguments against the schema when the server runs them.
const syncQuery: z.ZodType<UntypedQuery> = z.record(z.string(), z.record(z.string(), z.unknown()));

const queryResult: z.ZodType<QueryResult> = z.record(
  z.string(),
  z.array(z.looseObject({ id: z.string() })),
);

const removedIds = z.record(z.string(), z.array(z.string()));

const columnValue: z.ZodType<ColumnValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(columnValue), z.record(z.string(), columnValue)]));

const columnValues = z.record(z.string(), columnValue);

const rowLinks = z.record(z.string(), z.string().nullable());

const change: z.ZodType<Change> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), entity: z.string(), id: z.string(), values: columnValues, links: rowLinks.optional() }),
  z.object({ kind: z.literal("update"), entity: z.string(), id: z.string(), values: columnValues, links: rowLinks.optional() }),
  z.object({ kind: z.literal("link"), entity: z.string(), id: z.string(), field: z.string(), targetIds: z.array(z.string()) }),
  z.object({ kind: z.literal("unlink"), entity: z.string(), id: z.string(), field: z.string(), targetIds: z.array(z.string()) }),
  z.object({ kind: z.literal("delete"), entity: z.string(), id: z.string() }),
]);

const transactionStatus: z.ZodType<TransactionStatus> = z.enum(["committed", "denied"]);

const transactionEffect: z.ZodType<TransactionEffect> = z.object({
  transactionId: z.string(),
  tick: z.number().int(),
  status: transactionStatus,
  reason: z.string().nullable(),
  rows: queryResult,
  removed: removedIds,
});

const bucketKey: z.ZodType<BucketKeyJson> = z.object({
  model: z.string(),
  parts: z.array(z.object({ column: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) })),
});

// Buckets gained, with everything in them, and buckets lost.
const scopeChange = z.object({
  added: z.array(z.object({ key: bucketKey, generation: z.string(), rows: queryResult })),
  removed: z.array(z.string()),
});

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(jsonValue.nullable()),
    z.record(z.string(), jsonValue.nullable()),
  ]));

// The row whose presence room this is; whoever may read the row may be in it.
const presenceRoom = z.object({ entity: z.string(), id: z.string() });

const presencePeer = z.object({ userId: z.string().nullable(), state: jsonValue.nullable() });

const cursor = z.object({ bucket: z.string(), model: z.string(), tick: z.number().int() });

const clientMessage = z.discriminatedUnion("type", [
  // Where the client stands in each bucket it holds, and under which policy
  // generation each model's rows were downloaded.
  z.object({ type: z.literal("hello"), cursors: z.array(cursor), generations: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal("pull"), requestId: z.string(), query: syncQuery }),
  z.object({
    type: z.literal("commit"),
    requestId: z.string(),
    transaction: z.object({ id: z.string(), changes: z.array(change) }),
  }),
  // Enters the room, or updates the sender's state in it; null is present without a state.
  z.object({ type: z.literal("presence"), room: presenceRoom, state: jsonValue.nullable() }),
  z.object({ type: z.literal("leavePresence"), room: presenceRoom }),
]);

const serverMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pulled"), requestId: z.string(), data: queryResult }),
  z.object({ type: z.literal("failed"), requestId: z.string(), message: z.string() }),
  // The verdict on a transaction of the receiver's own, with the rows it ends
  // up with — and, when it changed what the receiver may see, that change too.
  z.object({ type: z.literal("effect"), effect: transactionEffect, scope: scopeChange.optional() }),
  // Rows that changed in buckets the receiver holds, as the receiver may see
  // them, and the buckets the same transaction gave or took: one tick, one message.
  z.object({
    type: z.literal("changed"),
    tick: z.number().int(),
    buckets: z.array(z.string()),
    rows: queryResult,
    removed: removedIds,
    scope: scopeChange.optional(),
  }),
  // Buckets the receiver gained, with their rows, and buckets it lost, with no
  // rows of its own changing: on reconnect, or a transaction that changed only access.
  z.object({ type: z.literal("scope"), tick: z.number().int(), ...scopeChange.shape }),
  // Models whose read policy changed since the receiver downloaded them: drop and start over.
  z.object({ type: z.literal("resync"), models: z.array(z.string()) }),
  // The hello has been answered in full.
  z.object({ type: z.literal("ready"), tick: z.number().int() }),
  // Everyone else in a room the receiver is in, whenever anyone there changes.
  z.object({ type: z.literal("presence"), room: presenceRoom, peers: z.array(presencePeer) }),
  // The receiver may not, or may no longer, read the room's row; it is out.
  z.object({ type: z.literal("presenceRefused"), room: presenceRoom }),
]);

export type ClientMessage = z.infer<typeof clientMessage>;
export type ServerMessage = z.infer<typeof serverMessage>;
export type BucketCursor = z.infer<typeof cursor>;
export type PresenceRoomRef = z.infer<typeof presenceRoom>;
export type PresencePeer = z.infer<typeof presencePeer>;

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

export function decodeClientMessage(frame: string): ClientMessage {
  return clientMessage.parse(JSON.parse(frame));
}

/** A JSON column's value, checked to be JSON all the way down. */
export function decodeColumnValue(value: unknown): ColumnValue {
  return columnValue.parse(value);
}

export function decodeChange(value: unknown): Change {
  return change.parse(value);
}

/** Column values are codec output and therefore JSON; this is where the type learns that. */
export function decodeJson(value: unknown): JsonValue {
  return jsonValue.parse(value);
}

export function decodeServerMessage(frame: string): ServerMessage {
  return serverMessage.parse(JSON.parse(frame));
}
