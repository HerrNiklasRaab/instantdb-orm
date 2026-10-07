import type { Socket } from "./Socket";

/**
 * A socket whose first frame is read on its own, before anyone listens for the
 * rest. Frames that arrive while the first one is being dealt with are held
 * and handed to the listener once there is one, in order.
 */
export class WaitingSocket implements Socket {
  private readonly held: string[] = [];
  private listener: ((frame: string) => void) | null = null;
  private resolveFirst: ((frame: string) => void) | null;
  readonly first: Promise<string>;

  constructor(private readonly socket: Socket) {
    let resolve: (frame: string) => void = () => undefined;
    this.first = new Promise((settle) => { resolve = settle; });
    this.resolveFirst = resolve;
    socket.onMessage((frame) => { this.receive(frame); });
  }

  send(frame: string): void {
    this.socket.send(frame);
  }

  onMessage(handler: (frame: string) => void): void {
    this.listener = handler;
    for (const frame of this.held.splice(0)) handler(frame);
  }

  onClose(handler: () => void): void {
    this.socket.onClose(handler);
  }

  close(): void {
    this.socket.close();
  }

  private receive(frame: string): void {
    if (this.resolveFirst) {
      this.resolveFirst(frame);
      this.resolveFirst = null;
    } else if (this.listener) {
      this.listener(frame);
    } else {
      this.held.push(frame);
    }
  }
}
