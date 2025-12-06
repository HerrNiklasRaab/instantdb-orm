import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { model } from "../../src/object-graph";
import { Match } from "./Match";

// MTI: No type getter → each class gets its own table (chessMatchs)
@model
export class ChessMatch extends Match {
  // Required fields (set in constructor)
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

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      _timeControl: observable,
      _rated: observable,
    } as any);
  }

  constructor(
    data: { id?: string; timeControl: string; rated: boolean }
  ) {
    super({ id: data.id });
    this._timeControl = data.timeControl;
    this._rated = data.rated;
    this.initTracking();
  }
}
