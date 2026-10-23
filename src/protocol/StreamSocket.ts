import { z } from "zod";
import { EventStreamReader, type StreamEvent } from "./ServerSentEvents";
import type { Socket } from "./Socket";

export const STREAM_PATH = "stream";
export const SEND_PATH = "send";
export const CONNECTION_EVENT = "connection";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface StreamSocketOptions {
  /** Sent with every request; where the caller's credentials go when a cookie does not carry them. */
  readonly headers?: Record<string, string>;
  /** Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
}

/**
 * The sync protocol over plain HTTP, for a server that cannot accept a
 * WebSocket: the server's frames arrive on one long-lived server-sent-events
 * response (`GET <base>/stream`); the client's go out in POSTs
 * (`POST <base>/send/<connection>`), the frames of one tick together, each
 * POST numbered so the server can put them back in order however the requests
 * overtake each other. The server names the connection in the stream's first
 * event; frames sent before it arrives wait. Whatever ends either request ends
 * the socket, and the sync client reconnects as it would after a dropped
 * WebSocket.
 */
export class StreamSocket implements Socket {
  private readonly abort = new AbortController();
  private readonly batch: string[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private readonly messageHandlers: ((frame: string) => void)[] = [];
  private readonly closeHandlers: (() => void)[] = [];
  private readonly fetch: FetchLike;
  private readonly opened = new Deferred();
  private connection: string | null = null;
  private flushScheduled = false;
  private sequence = 0;
  private closed = false;

  constructor(
    private readonly baseUrl: string,
    private readonly options: StreamSocketOptions = {},
  ) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    void this.listen();
  }

  send(frame: string): void {
    if (this.closed) return;
    this.batch.push(frame);
    this.scheduleFlush();
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
    this.abort.abort();
    this.opened.resolve();
    for (const handler of this.closeHandlers) handler();
  }

  /** Once the server has accepted every POST for the frames sent so far; at once when the socket is closed. */
  async flushed(): Promise<void> {
    await this.opened.promise;
    this.flushNow();
    while (this.inFlight.size > 0) await Promise.all(this.inFlight);
  }

  private async listen(): Promise<void> {
    try {
      const response = await this.fetch(`${this.baseUrl}/${STREAM_PATH}`, {
        headers: { accept: "text/event-stream", ...this.options.headers },
        signal: this.abort.signal,
      });
      if (response.ok && response.body !== null) await this.read(response.body);
    } catch {
      // The stream ended or never opened; either way the socket is over.
    }
    this.close();
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const events = new EventStreamReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      for (const event of events.feed(decoder.decode(value, { stream: true }))) this.receive(event);
    }
  }

  private receive(event: StreamEvent): void {
    if (event.name === CONNECTION_EVENT) {
      this.connection = event.data;
      this.opened.resolve();
      this.scheduleFlush();
    } else if (event.name === null) {
      for (const handler of this.messageHandlers) handler(event.data);
    }
  }

  // Frames sent in one tick travel in one request; the first one waits for the rest.
  private scheduleFlush(): void {
    if (this.flushScheduled || this.connection === null) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flushNow();
    });
  }

  private flushNow(): void {
    if (this.connection === null || this.batch.length === 0 || this.closed) return;
    const posting = this.post(this.connection, this.batch.splice(0));
    this.inFlight.add(posting);
    void posting.finally(() => this.inFlight.delete(posting));
  }

  private async post(connection: string, frames: string[]): Promise<void> {
    const sequence = this.sequence;
    this.sequence += frames.length;
    try {
      const response = await this.fetch(`${this.baseUrl}/${SEND_PATH}/${connection}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.options.headers },
        body: JSON.stringify({ sequence, frames } satisfies NumberedFrames),
        signal: this.abort.signal,
      });
      if (!response.ok) this.close();
    } catch {
      this.close();
    }
  }
}

class Deferred {
  readonly promise: Promise<void>;
  private settle: () => void = () => undefined;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  resolve(): void {
    this.settle();
  }
}

const numberedFrames = z.object({ sequence: z.number().int().nonnegative(), frames: z.array(z.string()).min(1) });

/** A POST's body: consecutive frames, and the place of the first in the client's sequence. */
export type NumberedFrames = z.infer<typeof numberedFrames>;

export function decodeNumberedFrames(body: string): NumberedFrames | null {
  try {
    const parsed = numberedFrames.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
