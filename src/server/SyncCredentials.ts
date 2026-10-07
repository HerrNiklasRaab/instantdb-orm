import { timingSafeEqual } from "node:crypto";
import type { SchemaDef } from "@zenstackhq/schema";
import type { Credential } from "../protocol/Credential";
import type { Principal } from "./Principal";
import type { SyncIdentity, SyncServer } from "./SyncServer";

/** The app's answer to "whose token is this": a live session's user, or nobody. */
export interface SessionLookup {
  identify(token: string): Promise<SyncIdentity | null>;
}

/**
 * Whom a connection acts as, from the credential it presents: the service
 * for the configured service token, otherwise the user the app's sessions
 * name. Without a service token configured, nobody connects as the service.
 */
export class SyncCredentials<Schema extends SchemaDef> {
  constructor(
    private readonly server: SyncServer<Schema>,
    private readonly sessions: SessionLookup,
    private readonly serviceToken: string | undefined,
  ) {}

  async principalFor(credential: Credential): Promise<Principal<Schema> | null> {
    if (this.isServiceToken(credential.token)) return this.server.unrestricted();
    const identity = await this.sessions.identify(credential.token);
    return identity === null ? null : this.server.principal(identity);
  }

  private isServiceToken(token: string): boolean {
    if (this.serviceToken === undefined) return false;
    const presented = Buffer.from(token);
    const expected = Buffer.from(this.serviceToken);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }
}
