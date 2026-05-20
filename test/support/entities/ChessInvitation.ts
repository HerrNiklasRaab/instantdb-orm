import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { model, field } from "../../../src/object-graph";
import { Invitation } from "./Invitation";
import type { User } from "./User";

@model
export class ChessInvitation extends Invitation {
  get modelType(): "chess" {
    return "chess";
  }

  // Subclass-only relationship. Schema declares `invitations.opponent`;
  // SkiInvitation deliberately does NOT have this field. Used to verify
  // the hydrator handles per-subclass relationship fields.
  opponent: User | null = null;

  // Required fields (set in constructor)
  @field()
  private _timeControl: string;
  @field()
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
    mobxMakeObservable<ChessInvitation, "_timeControl" | "_rated">(this, {
      _timeControl: observable,
      _rated: observable,
      opponent: observable.ref,
    });
  }

  constructor(timeControl: string, rated: boolean, id?: string) {
    super(id);
    this._timeControl = timeControl;
    this._rated = rated;
    this.initTracking();
  }
}
