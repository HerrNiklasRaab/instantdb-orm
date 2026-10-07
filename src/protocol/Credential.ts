import { z } from "zod";
import type { Socket } from "./Socket";

const frame = z.object({ type: z.literal("authenticate"), token: z.string().min(1) });

/**
 * Who a client acts as, sent as the first frame of its connection. A browser
 * cannot set headers on a WebSocket, so the token travels inside the socket,
 * the same way for every client.
 */
export class Credential {
  constructor(readonly token: string) {}

  static read(text: string): Credential | null {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    const parsed = frame.safeParse(json);
    return parsed.success ? new Credential(parsed.data.token) : null;
  }

  presentOn(socket: Socket): Socket {
    socket.send(JSON.stringify({ type: "authenticate", token: this.token }));
    return socket;
  }
}
