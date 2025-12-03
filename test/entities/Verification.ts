import { makeObservable, observable } from "mobx";
import { Model } from "../../src/object-graph/Model";

export class Verification extends Model {
  readonly id: string;

  createdAt: Date = undefined!;
  deletedAt: Date | null = null;
  expiresAt: Date = undefined!;
  identifier: string = undefined!;
  updatedAt: Date = undefined!;
  value: string = undefined!;

  constructor(id: string) {
    super();
    this.id = id;
    makeObservable(this, {
      createdAt: observable,
      deletedAt: observable,
      expiresAt: observable,
      identifier: observable,
      updatedAt: observable,
      value: observable,
    });
    this.initializeTracking();
  }
}
