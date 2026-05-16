import type { Model } from "../Model";
import { getEntityMeta, RelationshipFieldMeta } from "./EntityMeta";
import { makeAsyncDepth } from "./asyncDepth";

/**
 * Two stack-scoped guards backing the wirer:
 *
 *  1. **Wiring depth** — while active, MobX intercepts triggered by the
 *     wirer's own array push/splice or scalar set must NOT claim the
 *     affected model into the active transaction. Those mutations are
 *     bookkeeping; the *forward* side of the link is what the user
 *     mutated, and that's the row InstantDB persists with a `link` op.
 *     Without this guard, `post.author = otherUser` would also claim
 *     `otherUser`'s row and emit a stray `update` chunk against it,
 *     failing the wired side's `update` perm when the actor isn't
 *     `otherUser`.
 *
 *  2. **Constructor-sweep depth** — while active, the wirer must NOT
 *     write to a mid-construction owner. A parent building children
 *     inline does its own explicit `this.items.push(...)`; a wirer-driven
 *     push from each child's `wireConstructorRelationships` sweep would
 *     double-add. Outside any sweep, a mid-construction owner means an
 *     external party reached into us; the wirer should propagate the
 *     back-ref normally.
 */
const wiring = makeAsyncDepth();
const sweep = makeAsyncDepth();

export function isWiringInProgress(): boolean {
  return wiring.isActive();
}

export function withConstructorSweep<T>(fn: () => T): T {
  return sweep.wrap(fn);
}

/**
 * Mutates `owner`'s reverse field for `rel` to add or remove `value`.
 * Uses idempotent state checks so re-entrant observer callbacks bottom out
 * naturally (no flags needed). The `isWiringInProgress` guard in
 * `claimForCurrentTransaction` ensures these wirer-driven mutations don't
 * draw the wired side into the active transaction's commit.
 */
function applyReverseChange(
  owner: Model,
  value: Model,
  reverseRel: RelationshipFieldMeta,
  add: boolean
): void {
  // Owner is mid-construction (its own initTracking hasn't run yet) AND
  // the wire was triggered from inside someone's wireConstructorRelationships
  // sweep — i.e. an inline-built child is trying to wire back to its still-
  // building parent. The parent's constructor does its own explicit
  // back-ref push; we skip here to avoid double-adding. Outside any sweep,
  // a mid-construction owner means an external party touched us; the wirer
  // proceeds.
  if (owner._disposers == null && sweep.isActive()) return;

  const propName = reverseRel.getFieldNameOnModel(owner);
  const record = owner as unknown as Record<string, unknown>;

  if (reverseRel.isToMany()) {
    const arr = record[propName] as Model[] | undefined;
    if (!Array.isArray(arr)) return;
    if (add) {
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
  wiring.wrap(() => applyReverseChange(target, holder, reverseRel, add));
}
