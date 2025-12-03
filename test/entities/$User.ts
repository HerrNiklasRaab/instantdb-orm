import { makeObservable, observable } from "mobx";
import { Model } from "../../src/object-graph/Model";
import type { User } from "./User";

export class $User extends Model {
  readonly id: string;

  deletedAt: Date | null = null;
  email?: string = undefined;
  imageURL?: string = undefined;
  type?: string = undefined;

  // Relationships
  linkedPrimaryUser: $User | null = null;
  linkedGuestUsers: $User[] = [];
  user: User | null = null;

  constructor(id: string) {
    super();
    this.id = id;
    makeObservable(this, {
      deletedAt: observable,
      email: observable,
      imageURL: observable,
      type: observable,
      linkedPrimaryUser: observable.ref,
      linkedGuestUsers: observable.shallow,
      user: observable.ref,
    });
    this.initializeTracking();
  }
}
