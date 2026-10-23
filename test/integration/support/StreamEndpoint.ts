import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { SEND_PATH, STREAM_PATH, StreamSocket, type Socket } from "../../../src/protocol";

const IDENTITY_HEADER = "x-identity";

/** What an app's two route handlers do once they know whom a request acts as. */
export interface StreamRoutes {
  open(identityId: string | null, signal: AbortSignal): Response;
  deliver(connection: string, identityId: string | null, body: string): boolean;
  dropAll(): void;
}

/**
 * The two HTTP routes of the stream transport on a loopback port, served the
 * way an app's route handlers would: the client names its identity in a
 * header, standing in for the cookie a deployed endpoint reads.
 */
export class StreamEndpoint {
  private constructor(
    private readonly http: Server,
    private readonly routes: StreamRoutes,
    private readonly baseUrl: string,
  ) {}

  static async listen(routes: StreamRoutes): Promise<StreamEndpoint> {
    const http = createServer((request, response) => {
      void StreamEndpoint.serve(routes, request, response);
    });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", resolve);
    });
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("StreamEndpoint: no TCP address");
    return new StreamEndpoint(http, routes, `http://127.0.0.1:${String(address.port)}`);
  }

  connect(identityId: string | null): Socket {
    return new StreamSocket(this.baseUrl, { headers: identityId === null ? {} : { [IDENTITY_HEADER]: identityId } });
  }

  /** Every open stream ends, as if the server process had gone away. */
  dropConnections(): void {
    this.routes.dropAll();
  }

  close(): void {
    this.routes.dropAll();
    this.http.closeAllConnections();
    this.http.close();
  }

  private static async serve(routes: StreamRoutes, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://local");
    const identity = request.headers[IDENTITY_HEADER];
    const identityId = typeof identity === "string" ? identity : null;

    if (request.method === "GET" && url.pathname === `/${STREAM_PATH}`) {
      const gone = new AbortController();
      request.once("close", () => { gone.abort(); });
      const stream = routes.open(identityId, gone.signal);
      response.writeHead(stream.status, Object.fromEntries(stream.headers));
      if (stream.body !== null) await StreamEndpoint.pipe(stream.body, response);
      response.end();
      return;
    }

    const send = new RegExp(`^/${SEND_PATH}/([^/]+)$`).exec(url.pathname);
    if (request.method === "POST" && send?.[1] !== undefined) {
      const delivered = routes.deliver(send[1], identityId, await text(request));
      response.writeHead(delivered ? 204 : 404);
      response.end();
      return;
    }

    response.writeHead(404);
    response.end();
  }

  private static async pipe(body: ReadableStream<Uint8Array>, response: ServerResponse): Promise<void> {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      response.write(value);
    }
  }
}
