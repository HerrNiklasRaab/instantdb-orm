import { observable } from "mobx";
import { model } from "../../src/object-graph";
import { MatchRequest } from "./MatchRequest";

@model
export class SkiMatchRequest extends MatchRequest {
  get type(): "ski" {
    return "ski";
  }

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
    data: {
      createdAt: Date;
      resort: string;
      skillLevel: string;
    },
    id?: string
  ) {
    super(data, id);
    this._resort = data.resort;
    this._skillLevel = data.skillLevel;
    this.init({
      _createdAt: observable,
      _deletedAt: observable,
      _resort: observable,
      _skillLevel: observable,
      requester: observable.ref,
    });
  }
}
