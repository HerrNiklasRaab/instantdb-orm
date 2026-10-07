import type { SchemaDef } from "@zenstackhq/schema";
import { Credential } from "../protocol/Credential";
import type { Socket } from "../protocol/Socket";
import { WaitingSocket } from "../protocol/WaitingSocket";
import type { SyncCredentials } from "./SyncCredentials";
import type { SyncServer } from "./SyncServer";

/**
 * Lets a freshly opened socket in once its first frame names who it acts as;
 * a socket without a valid credential is closed before the server sees it.
 */
export class SocketAdmission<Schema extends SchemaDef> {
  constructor(
    private readonly server: SyncServer<Schema>,
    private readonly credentials: SyncCredentials<Schema>,
  ) {}

  admit(socket: Socket): void {
    const waiting = new WaitingSocket(socket);
    void waiting.first
      .then(async (frame) => {
        const credential = Credential.read(frame);
        const principal = credential === null ? null : await this.credentials.principalFor(credential);
        if (principal === null) waiting.close();
        else this.server.accept(waiting, principal);
      })
      .catch(() => { waiting.close(); });
  }
}
