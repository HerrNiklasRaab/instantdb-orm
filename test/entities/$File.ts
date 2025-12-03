import { makeObservable, observable } from "mobx";
import { Model } from "../../src/object-graph/Model";

export class $File extends Model {
  readonly id: string;

  deletedAt: Date | null = null;
  path: string = undefined!;
  url: string = undefined!;

  constructor(id: string) {
    super();
    this.id = id;
    makeObservable(this, {
      deletedAt: observable,
      path: observable,
      url: observable,
    });
    this.initializeTracking();
  }
}
