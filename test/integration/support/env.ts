export type TestTransport = "websocket" | "stream" | "in-process";

/**
 * `SYNC_TEST_TRANSPORT=in-process` skips the network and links client and
 * server directly; `stream` runs the suite over the HTTP stream transport
 * instead of a WebSocket.
 */
export function testTransport(): TestTransport {
  const configured = process.env.SYNC_TEST_TRANSPORT;
  if (configured === "in-process" || configured === "stream") return configured;
  return "websocket";
}
