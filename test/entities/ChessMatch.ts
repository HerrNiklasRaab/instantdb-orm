import { observable } from "mobx";
import { model } from "../../src/object-graph";
import { Match } from "./Match";

// MTI: No type getter → each class gets its own table (chessMatchs)
@model
export class ChessMatch extends Match {
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
    data: { createdAt: Date; timeControl: string; rated: boolean },
    id?: string
  ) {
    super(data, id);
    this._timeControl = data.timeControl;
    this._rated = data.rated;
    this.init({
      _createdAt: observable,
      _deletedAt: observable,
      _timeControl: observable,
      _rated: observable,
      requester: observable.ref,
    });
  }
}
