/** A position in Postgres's write-ahead log, as Postgres prints it: `16/B374D848`. */
export class Lsn {
  private constructor(private readonly value: bigint) {}

  static parse(text: string): Lsn {
    const [high, low] = text.split("/");
    if (high === undefined || low === undefined) throw new Error(`"${text}" is not a WAL position.`);
    return new Lsn((BigInt(`0x${high}`) << 32n) | BigInt(`0x${low}`));
  }

  isAfter(other: Lsn): boolean {
    return this.value > other.value;
  }

  toString(): string {
    return `${(this.value >> 32n).toString(16).toUpperCase()}/${(this.value & 0xffffffffn).toString(16).toUpperCase()}`;
  }
}
