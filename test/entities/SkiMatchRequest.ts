import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { model } from "../../src/object-graph";
import { MatchRequest } from "./MatchRequest";

@model
export class SkiMatchRequest extends MatchRequest {
  get type(): "ski" {
    return "ski";
  }

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
    data: {
      id?: string;
      resort: string;
      skillLevel: string;
    }
  ) {
    super({ id: data.id });
    this._resort = data.resort;
    this._skillLevel = data.skillLevel;
    this.initTracking();
  }
}
