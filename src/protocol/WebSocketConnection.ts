import type { Socket } from "./Socket";

const OPEN = 1;

/** The part of the WebSocket API shared by browsers, Node and the `ws` package. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

/** A WebSocket as the sync protocol's `Socket`, on either end of the connection. */
export class WebSocketConnection implements Socket {
  private readonly unsent: string[] = [];

  constructor(private readonly webSocket: WebSocketLike) {
    webSocket.addEventListener("open", () => {
      for (const frame of this.unsent.splice(0)) webSocket.send(frame);
    });
    // A failed connection also emits "close", which is what callers act on;
    // listening here keeps an EventEmitter-based socket from throwing.
    webSocket.addEventListener("error", () => undefined);
  }

  send(frame: string): void {
    if (this.webSocket.readyState === OPEN) this.webSocket.send(frame);
    else this.unsent.push(frame);
  }

  onMessage(handler: (frame: string) => void): void {
    this.webSocket.addEventListener("message", ({ data }) => {
      if (typeof data === "string") handler(data);
      else this.webSocket.close();
    });
  }

  onClose(handler: () => void): void {
    this.webSocket.addEventListener("close", handler);
  }

  close(): void {
    this.webSocket.close();
  }
}
