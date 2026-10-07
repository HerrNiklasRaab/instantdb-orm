import type { Socket } from "../../../src/protocol";

/**
 * A socket whose incoming frames arrive late, in order. Lets a test send a
 * message and act locally before the server's answer is in: the race a real
 * network produces by chance, made certain.
 */
export class LatentSocket implements Socket {
  constructor(
    private readonly inner: Socket,
    private readonly latencyMs: number,
  ) {}

  send(frame: string): void {
    this.inner.send(frame);
  }

  onMessage(handler: (frame: string) => void): void {
    this.inner.onMessage((frame) => {
      setTimeout(() => { handler(frame); }, this.latencyMs);
    });
  }

  onClose(handler: () => void): void {
    this.inner.onClose(handler);
  }

  close(): void {
    this.inner.close();
  }
}
