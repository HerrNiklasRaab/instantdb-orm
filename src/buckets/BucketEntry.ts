/** One row entering, changing in, or leaving one bucket at one log tick. */
export class BucketEntry {
  constructor(
    readonly bucket: string,
    readonly entity: string,
    readonly entityId: string,
    readonly removed: boolean,
  ) {}
}
