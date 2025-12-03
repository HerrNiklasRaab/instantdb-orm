import { makeObservable, observable } from "mobx";
import { Model } from "../../src/object-graph/Model";
import type { User } from "./User";

export class Session extends Model {
  readonly id: string;

  createdAt: Date = undefined!;
  deletedAt: Date | null = null;
  expiresAt: Date = undefined!;
  ipAddress?: string = undefined;
  token: string = undefined!;
  updatedAt: Date = undefined!;
  userAgent?: string = undefined;

  // Relationships
  user: User | null = null;

  constructor(id: string) {
    super();
    this.id = id;
    makeObservable(this, {
      createdAt: observable,
      deletedAt: observable,
      expiresAt: observable,
      ipAddress: observable,
      token: observable,
      updatedAt: observable,
      userAgent: observable,
      user: observable.ref,
    });
    this.initializeTracking();
  }
}
