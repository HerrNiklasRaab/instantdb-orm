import { makeObservable, observable } from "mobx";
import { model } from "../../src/object-graph";
import { MatchRequest } from "./MatchRequest";

@model
export class SkiMatchRequest extends MatchRequest {
  readonly type = "ski" as const;

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

  constructor(
    id: string,
    data: {
      createdAt: Date;
      resort: string;
      skillLevel: string;
    }
  ) {
    super(id, data);
    this._resort = data.resort;
    this._skillLevel = data.skillLevel;
    makeObservable<
      SkiMatchRequest,
      "_createdAt" | "_deletedAt" | "_resort" | "_skillLevel"
    >(this, {
      _createdAt: observable,
      _deletedAt: observable,
      _resort: observable,
      _skillLevel: observable,
      requester: observable.ref,
    });
    this._initTracker();
  }
}
