import type { Model } from "../Model";
import { getEntityMeta, RelationshipFieldMeta } from "./EntityMeta";

/**
 * Re-entrancy guard for reverse-link wiring. While >0, MobX intercepts
 * driven by the wirer's own array push/splice or scalar set must NOT claim
 * the affected model into the active transaction — those mutations are
 * bookkeeping (the *forward* side of the link is what the user mutated and
 * is being persisted with a `link` op), not user intent on the wired side.
 *
 * Without this guard, a `post.author = otherUser` mutation would also cause
 * `otherUser`'s row to be claimed, diffed, and emitted as an `update` op
 * on the wired side — which fails the wired side's `update` perm when the
 * actor isn't `otherUser`.
 */
let wiringDepth = 0;

export function isWiringInProgress(): boolean {
  return wiringDepth > 0;
}

/**
 * Mutates `owner`'s reverse field for `rel` to add or remove `value`.
 * Uses idempotent state checks so re-entrant observer callbacks bottom out
 * naturally (no flags needed). Applies the same add/remove delta to the
 * wired side's `originalSnapshot` via `acceptRelationshipDelta` so the
 * wirer's own mutation never shows up as a diff — but unrelated local
 * edits on the wired side stay dirty (this is what makes hydration safe:
 * a remote update splicing a sibling out won't clobber other local
 * additions).
 */
function applyReverseChange(
  owner: Model,
  value: Model,
  reverseRel: RelationshipFieldMeta,
  add: boolean
): void {
  // Owner is mid-construction (its own initTracking hasn't run yet). Its
  // constructor is responsible for whatever back-ref state it wants;
  // wiring would race with constructor-internal pushes and double-add.
  // Once the owner finishes initTracking its constructor sweep will pick
  // up any current relationship state.
  if (owner._tracker == null) return;

  const propName = reverseRel.getFieldNameOnModel(owner);
  const record = owner as unknown as Record<string, unknown>;

  if (reverseRel.isToMany()) {
    const arr = record[propName] as Model[] | undefined;
    if (!Array.isArray(arr)) return;
    if (add) {
      if (arr.includes(value)) return;
      arr.push(value);
    } else {
      const idx = arr.indexOf(value);
      if (idx === -1) return;
      arr.splice(idx, 1);
    }
  } else {
    if (add) {
      if (record[propName] === value) return;
      record[propName] = value;
    } else {
      if (record[propName] !== value) return;
      record[propName] = null;
    }
  }

  owner._tracker?.acceptRelationshipDelta(reverseRel.fieldName, value.id, add);
}

/**
 * Wires the reverse side of a forward relationship change.
 * `holder` had `rel` set/cleared; propagate to `target`'s back-reference.
 */
export function wireReverseLink(
  holder: Model,
  target: Model,
  rel: RelationshipFieldMeta,
  add: boolean
): void {
  const targetMeta = getEntityMeta(rel.targetEntity);
  const reverseRel = targetMeta.findReverseRelationship(rel.linkName, rel.fieldName);
  if (!reverseRel) return;
  wiringDepth++;
  try {
    applyReverseChange(target, holder, reverseRel, add);
  } finally {
    wiringDepth--;
  }
}
