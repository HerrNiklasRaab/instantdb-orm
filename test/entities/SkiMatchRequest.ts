import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { model } from "../../src/object-graph";
import { MatchRequest } from "./MatchRequest";

@model
export class SkiMatchRequest extends MatchRequest {
  get modelType(): "ski" {
    return "ski";
  }

  // Required fields (set in constructor)
  private _resort: string;
  private _skillLevel: string;

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

  constructor(resort: string, skillLevel: string, id?: string) {
    super(id);
    this._resort = resort;
    this._skillLevel = skillLevel;
    this.initTracking();
  }
}
