/** The part of a WebSocket both ends of the sync protocol rely on: ordered text frames. */
export interface Socket {
  send(frame: string): void;
  onMessage(handler: (frame: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}
