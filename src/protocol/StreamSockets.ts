import { encodeComment, encodeEvent } from "./ServerSentEvents";
import type { Socket } from "./Socket";
import { CONNECTION_EVENT, decodeNumberedFrames } from "./StreamSocket";

const DEFAULT_KEEP_ALIVE_MS = 25_000;

function isUnrefable(timer: unknown): timer is { unref(): void } {
  return typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function";
}

/**
 * The server end of a `StreamSocket`: a response whose body is the event
 * stream, and the frames the client POSTs for it. A comment every
 * `keepAliveMs` keeps an idle stream from being cut by whatever sits in
 * between. Ends when the client goes away (the body is cancelled, or the
 * request's signal aborts) or when the server closes it.
 */
class ServerStreamSocket implements Socket {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly body: ReadableStream<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private readonly messageHandlers: ((frame: string) => void)[] = [];
  private readonly closeHandlers: (() => void)[] = [];
  private readonly keepAlive: ReturnType<typeof setInterval>;
  private readonly early = new Map<number, string>();
  private expected = 0;
  private closed = false;

  constructor(
    readonly id: string,
    readonly ownerId: string | null,
    private readonly onClosed: () => void,
    keepAliveMs: number,
  ) {
    this.body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        this.write(encodeEvent(CONNECTION_EVENT, id));
      },
      cancel: () => {
        this.close();
      },
    });
    this.keepAlive = setInterval(() => {
      this.write(encodeComment("keep-alive"));
    }, keepAliveMs);
    if (isUnrefable(this.keepAlive)) this.keepAlive.unref();
  }

  response(): Response {
    return new Response(this.body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  /** Frames as the client numbered them; ones that overtook their predecessors wait for them. */
  receive(sequence: number, frames: string[]): void {
    frames.forEach((frame, offset) => this.early.set(sequence + offset, frame));
    for (let next = this.early.get(this.expected); next !== undefined; next = this.early.get(this.expected)) {
      this.early.delete(this.expected);
      this.expected += 1;
      for (const handler of this.messageHandlers) handler(next);
    }
  }

  send(frame: string): void {
    this.write(encodeEvent(null, frame));
  }

  onMessage(handler: (frame: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    try {
      this.controller?.close();
    } catch {
      // Already closed by the consumer.
    }
    this.onClosed();
    for (const handler of this.closeHandlers) handler();
  }

  private write(text: string): void {
    if (this.closed || this.controller === null) return;
    try {
      this.controller.enqueue(this.encoder.encode(text));
    } catch {
      this.close();
    }
  }
}

/**
 * Every open stream, by the connection id the client was given. Whoever
 * serves the two routes opens a stream here for an authenticated caller and
 * delivers that caller's POSTed frames; a frame for a connection somebody
 * else opened is refused.
 */
export class StreamSockets {
  private readonly open = new Map<string, ServerStreamSocket>();

  constructor(private readonly keepAliveMs = DEFAULT_KEEP_ALIVE_MS) {}

  /** Opens a stream for `ownerId`, hands the socket to `admit`, and returns the response to send back. */
  accept(ownerId: string | null, admit: (socket: Socket) => void, signal?: AbortSignal): Response {
    const id = crypto.randomUUID();
    const socket = new ServerStreamSocket(id, ownerId, () => this.open.delete(id), this.keepAliveMs);
    this.open.set(id, socket);
    signal?.addEventListener("abort", () => {
      socket.close();
    });
    admit(socket);
    return socket.response();
  }

  /** A POST's body from `ownerId` for `connection`; false when no such stream is open for them or the body is malformed. */
  deliver(connection: string, ownerId: string | null, body: string): boolean {
    const socket = this.open.get(connection);
    if (socket === undefined || socket.ownerId !== ownerId) return false;
    const numbered = decodeNumberedFrames(body);
    if (numbered === null) return false;
    socket.receive(numbered.sequence, numbered.frames);
    return true;
  }

  get size(): number {
    return this.open.size;
  }

  closeAll(): void {
    for (const socket of [...this.open.values()]) socket.close();
  }
}
