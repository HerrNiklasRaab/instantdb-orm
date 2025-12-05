import { makeObservable, observable } from "mobx";
import { model } from "../../src/object-graph";
import { Match } from "./Match";

// MTI: No type getter → each class gets its own table (skiMatchs)
@model
export class SkiMatch extends Match {
  declare private _resort: string;
  declare private _skillLevel: string;

  get resort(): string {
    return this._resort;
  }
  set resort(value: string) {
    this._resort = value;
  }

  get skillLevel(): string {
    return this._skillLevel;
  }
  set skillLevel(value: string) {
    this._skillLevel = value;
  }

  constructor(
    data: { id?: string; resort: string; skillLevel: string }
  ) {
    super({ id: data.id });
    this._resort = data.resort;
    this._skillLevel = data.skillLevel;
    makeObservable(this, {
      _resort: observable,
      _skillLevel: observable,
    } as any);
    this.initTracking();
  }
}
