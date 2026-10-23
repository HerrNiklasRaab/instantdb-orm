/** The part of a WebSocket both ends of the sync protocol rely on: ordered text frames. */
export interface Socket {
  send(frame: string): void;
  onMessage(handler: (frame: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
  /**
   * Resolves once every frame sent so far has reached the other end, or the
   * socket is closed. A socket that writes frames straight to the wire, as a
   * WebSocket does, leaves this out.
   */
  flushed?(): Promise<void>;
}
