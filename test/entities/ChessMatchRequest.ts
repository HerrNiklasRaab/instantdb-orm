import { makeObservable, observable } from "mobx";
import { model } from "../../src/object-graph";
import { MatchRequest } from "./MatchRequest";

@model
export class ChessMatchRequest extends MatchRequest {
  get type(): "chess" {
    return "chess";
  }

  declare private _timeControl: string;
  declare private _rated: boolean;

  get timeControl(): string {
    return this._timeControl;
  }
  set timeControl(value: string) {
    this._timeControl = value;
  }

  get rated(): boolean {
    return this._rated;
  }
  set rated(value: boolean) {
    this._rated = value;
  }

  constructor(
    data: {
      createdAt: Date;
      timeControl: string;
      rated: boolean;
    },
    id?: string
  ) {
    super(data, id);
    this._timeControl = data.timeControl;
    this._rated = data.rated;
    makeObservable(this, {
      _timeControl: observable,
      _rated: observable,
    } as any);
    this.initTracking();
  }
}
