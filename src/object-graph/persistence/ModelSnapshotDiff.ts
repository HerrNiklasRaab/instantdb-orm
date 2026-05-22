import type { EntityName } from "../store/EntityMeta";
import { getEntityAttrs, getEntityLinks } from "../store/EntityMeta";
import type { ModelSnapshot } from "./ModelSnapshot";
import type { AttrsDefs } from "@instantdb/core";

/**
 * Computes the difference between two ModelSnapshots.
 * Used by ScopedTransaction to determine what needs to be persisted.
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
    this.computeScalarDiff(entityName);
    this.computeRelationshipDiff(entityName);
  }

  hasChanges(): boolean {
    return (
      this.scalars.size > 0 || this.links.size > 0 || this.unlinks.size > 0
    );
  }

  private computeScalarDiff(entityName: EntityName): void {
    const attrs = getEntityAttrs(entityName);
    if (this.isNew) {
      for (const fieldName of Object.keys(attrs)) {
        if (fieldName === "id") continue;
        this.scalars.set(fieldName, this.current.scalars.get(fieldName));
      }
    } else {
      for (const fieldName of Object.keys(attrs)) {
        if (fieldName === "id") continue;
        const originalValue = this.original.scalars.get(fieldName);
        const currentValue = this.current.scalars.get(fieldName);
        if (!attrValuesEqual(attrs, fieldName, originalValue, currentValue)) {
          this.scalars.set(fieldName, currentValue);
        }
      }
    }
  }

  private computeRelationshipDiff(entityName: EntityName): void {
    for (const [fieldName, linkAttr] of Object.entries(getEntityLinks(entityName))) {
      if (linkAttr.cardinality === "one") {
        this.computeToOneDiff(fieldName);
      } else {
        this.computeToManyDiff(fieldName);
      }
    }
  }

  private computeToOneDiff(fieldName: string): void {
    const currentId = toScalarId(this.current.relationships.get(fieldName));
    const originalId = toScalarId(this.original.relationships.get(fieldName));

    if (originalId !== currentId) {
      if (originalId) {
        const existing = this.unlinks.get(fieldName) ?? [];
        existing.push(originalId);
        this.unlinks.set(fieldName, existing);
      }
      if (currentId) {
        const existing = this.links.get(fieldName) ?? [];
        existing.push(currentId);
        this.links.set(fieldName, existing);
      }
    }
  }

  private computeToManyDiff(fieldName: string): void {
    const currentIds = toIdArray(this.current.relationships.get(fieldName));
    const originalIds = toIdArray(this.original.relationships.get(fieldName));
    const origSet = new Set(originalIds);
    const currSet = new Set(currentIds);

    const toLink: string[] = [];
    for (const id of currSet) {
      if (!origSet.has(id)) {
        toLink.push(id);
      }
    }
    if (toLink.length > 0) {
      this.links.set(fieldName, toLink);
    }

    if (!this.isNew) {
      const toUnlink: string[] = [];
      for (const id of origSet) {
        if (!currSet.has(id)) {
          toUnlink.push(id);
        }
      }
      if (toUnlink.length > 0) {
        this.unlinks.set(fieldName, toUnlink);
      }
    }
  }
}

function attrValuesEqual(
  attrs: AttrsDefs,
  fieldName: string,
  a: unknown,
  b: unknown
): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  const attr = attrs[fieldName];
  if (attr && attr.valueType === "json") return jsonValuesEqual(a, b);
  return false;
}

function jsonValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonValuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!jsonValuesEqual(Reflect.get(a, k), Reflect.get(b, k))) return false;
    }
    return true;
  }
  return false;
}

function toIdArray(value: string | string[] | null | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function toScalarId(value: string | string[] | null | undefined): string | null {
  return typeof value === "string" ? value : null;
}
