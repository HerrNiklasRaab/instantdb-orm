export interface StreamEvent {
  readonly name: string | null;
  readonly data: string;
}

/** One server-sent event as text: `event:` when named, one `data:` line per line of data, a blank line to end it. */
export function encodeEvent(name: string | null, data: string): string {
  const lines = data.split("\n").map((line) => `data: ${line}`);
  return `${name === null ? "" : `event: ${name}\n`}${lines.join("\n")}\n\n`;
}

export function encodeComment(text: string): string {
  return `: ${text}\n\n`;
}

/** Reassembles events from the text of a server-sent-events body, however it was chunked. */
export class EventStreamReader {
  private pending = "";
  private name: string | null = null;
  private data: string[] = [];

  feed(text: string): StreamEvent[] {
    this.pending += text;
    const events: StreamEvent[] = [];
    let newline = this.pending.indexOf("\n");
    while (newline !== -1) {
      const line = this.pending.slice(0, newline).replace(/\r$/, "");
      this.pending = this.pending.slice(newline + 1);
      const event = this.readLine(line);
      if (event !== null) events.push(event);
      newline = this.pending.indexOf("\n");
    }
    return events;
  }

  private readLine(line: string): StreamEvent | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") this.name = value;
    else if (field === "data") this.data.push(value);
    return null;
  }

  private dispatch(): StreamEvent | null {
    const event = this.data.length === 0 ? null : { name: this.name, data: this.data.join("\n") };
    this.name = null;
    this.data = [];
    return event;
  }
}
