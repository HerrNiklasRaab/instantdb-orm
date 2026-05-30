import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model, field } from "../../../src/object-graph";
import type { User } from "./User";

// Abstract base - NOT decorated with @model (children are).
// `@field()` on `_status` mirrors the bl-package pattern where an STI
// abstract base contributes its own @field-decorated column. Exercises
// the metadata-inheritance walk across three levels (Model → Invitation →
// ChessInvitation/SkiInvitation).
export abstract class Invitation extends Model {
  abstract readonly modelType: string; // discriminator

  // Relationship to User
  inviter: User | null = null;

  @field()
  private _status: string = "pending";

  get status(): string {
    return this._status;
  }
  set status(value: string) {
    this._status = value;
  }

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable<this, "_status">(this, {
      inviter: observable.ref,
      _status: observable,
    });
  }
}
