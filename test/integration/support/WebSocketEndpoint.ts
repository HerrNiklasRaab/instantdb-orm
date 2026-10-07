import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { WebSocketConnection, type Socket } from "../../../src/protocol";

const IDENTITY_PARAM = "as";

/**
 * A real WebSocket server on a Unix socket file: the full handshake and
 * framing run, but no port is opened and nothing is reachable from the
 * network. The client names its identity in the URL, standing in for the
 * authentication a deployed endpoint performs on the upgrade request.
 */
export class WebSocketEndpoint {
  private constructor(
    private readonly directory: string,
    private readonly socketPath: string,
    private readonly http: Server,
    private readonly webSockets: WebSocketServer,
  ) {}

  static async listen(accept: (socket: Socket, identityId: string | null) => void): Promise<WebSocketEndpoint> {
    const directory = mkdtempSync(join(tmpdir(), "sync-"));
    const socketPath = join(directory, "ws.sock");
    const http = createServer();
    const webSockets = new WebSocketServer({ server: http });
    webSockets.on("connection", (webSocket, request) => {
      const identityId = new URL(request.url ?? "/", "ws://local").searchParams.get(IDENTITY_PARAM);
      accept(new WebSocketConnection(webSocket), identityId);
    });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(socketPath, resolve);
    });
    return new WebSocketEndpoint(directory, socketPath, http, webSockets);
  }

  connect(identityId: string | null): Socket {
    const query = identityId === null ? "" : `?${IDENTITY_PARAM}=${encodeURIComponent(identityId)}`;
    return new WebSocketConnection(new WebSocket(`ws+unix:${this.socketPath}:/${query}`));
  }

  close(): void {
    for (const webSocket of this.webSockets.clients) webSocket.terminate();
    this.webSockets.close();
    this.http.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
