import type { EntityName } from "../store/EntityMeta";
import { getEntityAttrs, getEntityLinks } from "../store/EntityMeta";
import type { ModelSnapshot } from "./ModelSnapshot";
import type { FieldDef } from "@zenstackhq/schema";
import type { ColumnValue } from "../columns/types";

/**
 * Computes the difference between two ModelSnapshots.
 * Used by ScopedTransaction to determine what needs to be persisted.
 */
export class ModelSnapshotDiff {
  readonly scalars = new Map<string, ColumnValue>();
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
        const value = this.current.scalars.get(fieldName);
        if (fieldName === "id" || value === undefined) continue;
        this.scalars.set(fieldName, value);
      }
    } else {
      for (const fieldName of Object.keys(attrs)) {
        if (fieldName === "id") continue;
        const originalValue = this.original.scalars.get(fieldName);
        const currentValue = this.current.scalars.get(fieldName);
        if (currentValue !== undefined && !attrValuesEqual(attrs, fieldName, originalValue, currentValue)) {
          this.scalars.set(fieldName, currentValue);
        }
      }
    }
  }

  private computeRelationshipDiff(entityName: EntityName): void {
    for (const [fieldName, linkAttr] of Object.entries(getEntityLinks(entityName))) {
      if (!linkAttr.array) {
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
  attrs: Readonly<Record<string, FieldDef>>,
  fieldName: string,
  a: ColumnValue | undefined,
  b: ColumnValue
): boolean {
  // Snapshot scalars are already codec-serialized column values (Temporal →
  // ISO string), so scalar columns compare by `===`. Only json columns need a
  // structural compare.
  if (a === b) return true;
  const attr = attrs[fieldName];
  if (attr && attr.type === "Json") return jsonValuesEqual(a, b);
  return false;
}

function isJsonArray(value: ColumnValue | undefined): value is readonly ColumnValue[] {
  return Array.isArray(value);
}

function isJsonObject(value: ColumnValue | undefined): value is { readonly [key: string]: ColumnValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValuesEqual(a: ColumnValue | undefined, b: ColumnValue | undefined): boolean {
  if (a === b) return true;
  if (isJsonArray(a) && isJsonArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonValuesEqual(item, b[index]));
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => jsonValuesEqual(a[key], b[key]));
  }
  return false;
}

function toIdArray(value: string | string[] | null | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function toScalarId(value: string | string[] | null | undefined): string | null {
  return typeof value === "string" ? value : null;
}
