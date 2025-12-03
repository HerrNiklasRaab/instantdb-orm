import { makeObservable, observable } from "mobx";
import { Model } from "../../src/object-graph/Model";
import type { $User } from "./$User";
import type { Account } from "./Account";
import type { Session } from "./Session";

export class User extends Model {
  readonly id: string;

  createdAt: Date = undefined!;
  deletedAt: Date | null = null;
  email: string = undefined!;
  emailVerified: boolean = undefined!;
  image?: string = undefined;
  name: string = undefined!;
  updatedAt: Date = undefined!;

  // Relationships
  $user: $User | null = null;
  accounts: Account[] = [];
  sessions: Session[] = [];

  constructor(id: string) {
    super();
    this.id = id;
    makeObservable(this, {
      createdAt: observable,
      deletedAt: observable,
      email: observable,
      emailVerified: observable,
      image: observable,
      name: observable,
      updatedAt: observable,
      $user: observable.ref,
      accounts: observable.shallow,
      sessions: observable.shallow,
    });
    this.initializeTracking();
  }
}
