import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { model } from "../../src/object-graph";
import { Match } from "./Match";

// MTI: No type getter → each class gets its own table (skiMatchs)
@model
export class SkiMatch extends Match {
  private _resort: string = undefined!;
  private _skillLevel: string = undefined!;

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

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      _resort: observable,
      _skillLevel: observable,
    } as any);
  }

  constructor(
    data: { id?: string; resort: string; skillLevel: string }
  ) {
    super({ id: data.id });
    this._resort = data.resort;
    this._skillLevel = data.skillLevel;
    this.initTracking();
  }
}
