import { makeObservable, observable } from "mobx";
import { Model } from "../../src/object-graph/Model";
import type { User } from "./User";

export class Account extends Model {
  readonly id: string;

  accessToken?: string = undefined;
  accessTokenExpiresAt?: Date = undefined;
  accountId: string = undefined!;
  createdAt: Date = undefined!;
  deletedAt: Date | null = null;
  idToken?: string = undefined;
  password?: string = undefined;
  providerId: string = undefined!;
  refreshToken?: string = undefined;
  refreshTokenExpiresAt?: Date = undefined;
  scope?: string = undefined;
  updatedAt: Date = undefined!;

  // Relationships
  user: User | null = null;

  constructor(id: string) {
    super();
    this.id = id;
    makeObservable(this, {
      accessToken: observable,
      accessTokenExpiresAt: observable,
      accountId: observable,
      createdAt: observable,
      deletedAt: observable,
      idToken: observable,
      password: observable,
      providerId: observable,
      refreshToken: observable,
      refreshTokenExpiresAt: observable,
      scope: observable,
      updatedAt: observable,
      user: observable.ref,
    });
    this.initializeTracking();
  }
}
