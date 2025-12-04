import { observe } from "mobx";
import type { IEntity } from "../IdentityMap";
import type { EntityName } from "../store/EntityMeta";
import { getEntityMeta, getPropertyName } from "../store/EntityMeta";

export interface TrackedChanges {
  scalars: Map<string, unknown>;
  links: Map<string, string[]>;
  unlinks: Map<string, string[]>;
}

export class ChangeTracker {
  private disposers: (() => void)[] = [];
  private dirtyScalars = new Map<string, unknown>();
  private originalRelationships = new Map<string, string | string[] | null>();
  private currentRelationships = new Map<string, string | string[] | null>();
  private _isNew = true;

  constructor(
    private entity: IEntity,
    private entityName: EntityName
  ) {
    this.captureOriginalState();
    this.setupObservers();
  }

  /** Returns true if entity has never been saved */
  isNew(): boolean {
    return this._isNew;
  }

  /** Mark entity as not new (already exists in database) */
  markNotNew(): void {
    this._isNew = false;
  }

  private captureOriginalState(): void {
    const meta = getEntityMeta(this.entityName);
    const record = this.entity as unknown as Record<string, unknown>;

    // Capture relationship state (use private backing field if exists)
    for (const rel of meta.relationshipFields) {
      const propName = getPropertyName(this.entity, rel.fieldName);
      const value = record[propName];
      if (rel.isToOne()) {
        const entityRef = value as IEntity | null;
        this.originalRelationships.set(rel.fieldName, entityRef?.id ?? null);
        this.currentRelationships.set(rel.fieldName, entityRef?.id ?? null);
      } else {
        const entities = (value as IEntity[] | undefined) ?? [];
        const ids = entities.map((e) => e.id);
        this.originalRelationships.set(rel.fieldName, [...ids]);
        this.currentRelationships.set(rel.fieldName, [...ids]);
      }
    }
  }

  private setupObservers(): void {
    const meta = getEntityMeta(this.entityName);
    const record = this.entity as unknown as Record<string, unknown>;

    // Observe scalar field changes (use private backing field if exists)
    for (const fieldName of meta.scalarFields) {
      if (fieldName === "id") continue;
      const propName = getPropertyName(this.entity, fieldName);

      try {
        const disposer = observe(
          this.entity as object,
          propName as never,
          (change) => {
            if (change.type === "update") {
              // Store with schema field name as key
              this.dirtyScalars.set(fieldName, change.newValue);
            }
          }
        );
        this.disposers.push(disposer);
      } catch {
        // Field might not be observable, skip it
      }
    }

    // Observe relationship changes (use private backing field if exists)
    for (const rel of meta.relationshipFields) {
      const propName = getPropertyName(this.entity, rel.fieldName);

      if (rel.isToOne()) {
        // observable.ref - observe the reference change
        try {
          const disposer = observe(
            this.entity as object,
            propName as never,
            (change) => {
              if (change.type === "update") {
                const newEntity = change.newValue as IEntity | null;
                this.currentRelationships.set(
                  rel.fieldName,
                  newEntity?.id ?? null
                );
              }
            }
          );
          this.disposers.push(disposer);
        } catch {
          // Field might not be observable, skip it
        }
      } else {
        // observable.shallow - observe array changes
        const array = record[propName] as IEntity[] | undefined;
        if (array && Array.isArray(array)) {
          try {
            const disposer = observe(array, () => {
              // Recalculate current IDs on any array change
              const currentIds = array.map((e) => e.id);
              this.currentRelationships.set(rel.fieldName, currentIds);
            });
            this.disposers.push(disposer);
          } catch {
            // Array might not be observable, skip it
          }
        }
      }
    }
  }

  getChanges(): TrackedChanges {
    const meta = getEntityMeta(this.entityName);
    const record = this.entity as unknown as Record<string, unknown>;
    const links = new Map<string, string[]>();
    const unlinks = new Map<string, string[]>();

    // For new entities, return ALL scalar fields (excluding id)
    // For existing entities, return only dirty scalars
    let scalars: Map<string, unknown>;
    if (this._isNew) {
      scalars = new Map<string, unknown>();
      for (const fieldName of meta.scalarFields) {
        if (fieldName === "id") continue;
        // Read from private backing field if exists, key by schema name
        const propName = getPropertyName(this.entity, fieldName);
        scalars.set(fieldName, record[propName]);
      }
    } else {
      scalars = new Map(this.dirtyScalars);
    }

    // Calculate link/unlink changes
    for (const rel of meta.relationshipFields) {
      const original = this.originalRelationships.get(rel.fieldName);
      const current = this.currentRelationships.get(rel.fieldName);

      if (rel.isToOne()) {
        const origId = original as string | null;
        const currId = current as string | null;

        if (origId !== currId) {
          if (origId) {
            const existing = unlinks.get(rel.linkName) ?? [];
            existing.push(origId);
            unlinks.set(rel.linkName, existing);
          }
          if (currId) {
            const existing = links.get(rel.linkName) ?? [];
            existing.push(currId);
            links.set(rel.linkName, existing);
          }
        }
      } else {
        const origIds = new Set(original as string[]);
        const currIds = new Set(current as string[]);

        // Find added (to link)
        const toLink: string[] = [];
        for (const id of currIds) {
          if (!origIds.has(id)) {
            toLink.push(id);
          }
        }
        if (toLink.length > 0) {
          links.set(rel.linkName, toLink);
        }

        // Find removed (to unlink)
        const toUnlink: string[] = [];
        for (const id of origIds) {
          if (!currIds.has(id)) {
            toUnlink.push(id);
          }
        }
        if (toUnlink.length > 0) {
          unlinks.set(rel.linkName, toUnlink);
        }
      }
    }

    return {
      scalars,
      links,
      unlinks,
    };
  }

  hasChanges(): boolean {
    // New entities always have changes (need to be inserted)
    if (this._isNew) {
      return true;
    }
    const changes = this.getChanges();
    return (
      changes.scalars.size > 0 ||
      changes.links.size > 0 ||
      changes.unlinks.size > 0
    );
  }

  reset(): void {
    this._isNew = false;
    this.dirtyScalars.clear();
    this.captureOriginalState();
  }

  dispose(): void {
    for (const disposer of this.disposers) {
      disposer();
    }
    this.disposers = [];
  }
}
