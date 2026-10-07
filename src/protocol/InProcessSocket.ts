import type { Socket } from "./Socket";

class InProcessSocketEnd implements Socket {
  private readonly messageHandlers: ((frame: string) => void)[] = [];
  private readonly closeHandlers: (() => void)[] = [];
  private peer: InProcessSocketEnd | null = null;
  private open = true;

  constructor(private readonly latencyMs: number) {}

  connect(peer: InProcessSocketEnd): void {
    this.peer = peer;
  }

  send(frame: string): void {
    const peer = this.peer;
    if (!this.open || !peer) return;
    setTimeout(() => { peer.deliver(frame); }, this.latencyMs);
  }

  onMessage(handler: (frame: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    this.shutDown();
    this.peer?.shutDown();
  }

  private deliver(frame: string): void {
    if (!this.open) return;
    for (const handler of this.messageHandlers) handler(frame);
  }

  private shutDown(): void {
    if (!this.open) return;
    this.open = false;
    setTimeout(() => {
      for (const handler of this.closeHandlers) handler();
    }, 0);
  }
}

/**
 * Two linked socket ends in one process, for a client that runs beside its
 * server. Frames are strings delivered on a later macrotask, in order, so
 * nothing crosses by reference and nothing arrives synchronously — the same
 * guarantees a WebSocket gives, which is what makes the two interchangeable.
 */
export function inProcessSocketPair(options: { latencyMs?: number } = {}): [client: Socket, server: Socket] {
  const latencyMs = options.latencyMs ?? 0;
  const client = new InProcessSocketEnd(latencyMs);
  const server = new InProcessSocketEnd(latencyMs);
  client.connect(server);
  server.connect(client);
  return [client, server];
}
