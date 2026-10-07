import { configure } from "mobx";
configure({ enforceActions: "never" });

// Re-export everything from object-graph
export * from "./object-graph/index";
export * from "./client";
export { Credential, inProcessSocketPair, WebSocketConnection, type Socket, type WebSocketLike } from "./protocol";
export { SyncSchema } from "./schema/SyncSchema";
