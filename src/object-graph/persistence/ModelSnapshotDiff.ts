import type { EntityName } from "../store/EntityMeta";
import { getEntityMeta } from "../store/EntityMeta";
import type { ModelSnapshot } from "./ModelSnapshot";

/**
 * Computes the difference between two ModelSnapshots.
 * Used by ChangeTracker to determine what needs to be persisted.
 */
export class ModelSnapshotDiff {
  readonly scalars = new Map<string, unknown>();
  readonly links = new Map<string, string[]>();
  readonly unlinks = new Map<string, string[]>();

  constructor(
    private original: ModelSnapshot,
    private current: ModelSnapshot,
    entityName: EntityName,
    private isNew: boolean
  ) {
    const meta = getEntityMeta(entityName);
    this.computeScalarDiff(meta);
    this.computeRelationshipDiff(meta);
  }

  hasChanges(): boolean {
    return (
      this.scalars.size > 0 || this.links.size > 0 || this.unlinks.size > 0
    );
  }

  private computeScalarDiff(meta: ReturnType<typeof getEntityMeta>): void {
    if (this.isNew) {
      // New entity: include ALL scalar fields (excluding id)
      for (const field of meta.scalarFields) {
        if (field.fieldName === "id") continue;
        this.scalars.set(field.fieldName, this.current.scalars.get(field.fieldName));
      }
    } else {
      // Existing entity: include only changed scalars
      for (const field of meta.scalarFields) {
        if (field.fieldName === "id") continue;
        const originalValue = this.original.scalars.get(field.fieldName);
        const currentValue = this.current.scalars.get(field.fieldName);
        if (!scalarsEqual(originalValue, currentValue)) {
          this.scalars.set(field.fieldName, currentValue);
        }
      }
    }
  }

  private computeRelationshipDiff(
    meta: ReturnType<typeof getEntityMeta>
  ): void {
    for (const rel of meta.relationshipFields) {
      if (rel.isToOne()) {
        this.computeToOneDiff(rel);
      } else {
        this.computeToManyDiff(rel);
      }
    }
  }

  private computeToOneDiff(rel: { fieldName: string; linkName: string }): void {
    const currentId = this.current.relationships.get(rel.fieldName) as
      | string
      | null;

    if (this.isNew) {
      // New entity: include current relationship as link
      if (currentId) {
        const existing = this.links.get(rel.linkName) ?? [];
        existing.push(currentId);
        this.links.set(rel.linkName, existing);
      }
    } else {
      // Existing entity: compare original vs current
      const originalId = this.original.relationships.get(rel.fieldName) as
        | string
        | null;

      if (originalId !== currentId) {
        if (originalId) {
          const existing = this.unlinks.get(rel.linkName) ?? [];
          existing.push(originalId);
          this.unlinks.set(rel.linkName, existing);
        }
        if (currentId) {
          const existing = this.links.get(rel.linkName) ?? [];
          existing.push(currentId);
          this.links.set(rel.linkName, existing);
        }
      }
    }
  }

  private computeToManyDiff(rel: {
    fieldName: string;
    linkName: string;
  }): void {
    const currentIds =
      (this.current.relationships.get(rel.fieldName) as string[]) ?? [];

    if (this.isNew) {
      // New entity: include all current array members as links
      if (currentIds.length > 0) {
        this.links.set(rel.linkName, currentIds);
      }
    } else {
      // Existing entity: compute diffs
      const originalIds =
        (this.original.relationships.get(rel.fieldName) as string[]) ?? [];
      const origSet = new Set(originalIds);
      const currSet = new Set(currentIds);

      // Find added (to link)
      const toLink: string[] = [];
      for (const id of currSet) {
        if (!origSet.has(id)) {
          toLink.push(id);
        }
      }
      if (toLink.length > 0) {
        this.links.set(rel.linkName, toLink);
      }

      // Find removed (to unlink)
      const toUnlink: string[] = [];
      for (const id of origSet) {
        if (!currSet.has(id)) {
          toUnlink.push(id);
        }
      }
      if (toUnlink.length > 0) {
        this.unlinks.set(rel.linkName, toUnlink);
      }
    }
  }
}

function scalarsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return false;
}
