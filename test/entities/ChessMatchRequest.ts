import { makeObservable, observable } from "mobx";
import { model } from "../../src/object-graph";
import { MatchRequest } from "./MatchRequest";

@model
export class ChessMatchRequest extends MatchRequest {
  readonly type = "chess" as const;

  private _timeControl: string;
  private _rated: boolean;

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
    id: string,
    data: {
      createdAt: Date;
      timeControl: string;
      rated: boolean;
    }
  ) {
    super(id, data);
    this._timeControl = data.timeControl;
    this._rated = data.rated;
    makeObservable<
      ChessMatchRequest,
      "_createdAt" | "_deletedAt" | "_timeControl" | "_rated"
    >(this, {
      _createdAt: observable,
      _deletedAt: observable,
      _timeControl: observable,
      _rated: observable,
      requester: observable.ref,
    });
    this._initTracker();
  }
}
