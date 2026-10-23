import type { SchemaDef } from "@zenstackhq/schema";
import { StreamSockets } from "../protocol/StreamSockets";
import type { Principal } from "./Principal";
import type { AcceptOptions, SyncServer } from "./SyncServer";

// The service and an anonymous caller both have no author id; a stream is
// only ever fed by whoever opened it, so the key must tell them apart.
function ownerKeyOf(principal: Principal): string | null {
  if (principal.isUnrestricted) return "~service";
  return principal.authorId;
}

/**
 * Lets browsers in over the HTTP stream transport, the way `SocketAdmission`
 * lets WebSockets in: the app's route handlers work out whom a request acts
 * as and pass the principal here. `open` answers the stream request; `deliver`
 * takes a POSTed body, refusing one for a stream somebody else opened.
 */
export class StreamAdmission<Schema extends SchemaDef = SchemaDef> {
  private readonly streams: StreamSockets;

  constructor(
    private readonly server: SyncServer<Schema>,
    options: { keepAliveMs?: number } = {},
  ) {
    this.streams = new StreamSockets(options.keepAliveMs);
  }

  open(principal: Principal<Schema>, signal?: AbortSignal, options: AcceptOptions = {}): Response {
    return this.streams.accept(
      ownerKeyOf(principal),
      (socket) => {
        this.server.accept(socket, principal, options);
      },
      signal,
    );
  }

  deliver(connection: string, principal: Principal<Schema>, body: string): boolean {
    return this.streams.deliver(connection, ownerKeyOf(principal), body);
  }

  get openStreams(): number {
    return this.streams.size;
  }

  close(): void {
    this.streams.closeAll();
  }
}
