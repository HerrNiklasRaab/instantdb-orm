export type TestTransport = "websocket" | "in-process";

/** `SYNC_TEST_TRANSPORT=in-process` skips the WebSocket and links client and server directly. */
export function testTransport(): TestTransport {
  return process.env.SYNC_TEST_TRANSPORT === "in-process" ? "in-process" : "websocket";
}
