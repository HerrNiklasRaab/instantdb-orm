# Reconciliation vs. pending state

Design record for [PendingNewHydration.test.ts](./PendingNewHydration.test.ts).
Distilled from the 2026-07-31 investigation that started as a failing app e2e
and ended as an ORM fix.

## The incident

The ghost-recovery e2e (`app/test/integration/ghost-recovery/`) had a user
enter the app for the first time with a busy sync backlog (party, chat,
accepted invitation). Her `Installation` create was rejected by InstantDB with
*permission denied* — every run, while the identical code path passed for every
quieter user.

The denial was correct: the transaction on the wire carried the installation's
scalar columns but **no `$user` link triple**, so the `isOwner` rule
(`auth.id in data.ref('$user.id')`) evaluated against an ownerless row. The
client had sent a corrupted write. Instrumentation of the commit path showed
the link was already `null` in memory at serialization time — milliseconds
after the constructor had set it to a correct, store-backed user.

## The mechanism

1. A transaction constructs the installation; the reverse-link wiring mirrors
   `installation.$user = user` into `user.installations`.
2. A `$users` subscription snapshot — computed by the server *before* the
   commit, so truthfully reporting `installations: []` — is queued.
3. The transaction's `await` yields; the hydrator reconciles the snapshot:
   it rebuilt `user.installations` from the server list, evicting the
   pending installation.
4. The eviction splice fires the reverse-link wiring, which nulls the forward
   side: `installation.$user = null`.
5. The commit snapshots `$user → null` → no link op → permission denied.

## Why the existing protection didn't cover it

The hydrator already skips *touched* fields — fields claimed by an open
transaction. But there are two write paths, and only one is claimed:

| write path                    | claimed?          | hydration-protected?    |
| ----------------------------- | ----------------- | ----------------------- |
| user code sets the field      | yes               | yes (`isFieldTouched`)  |
| the wiring sets the reverse   | **no, by design** | **no — this was the bug** |

Wiring writes are deliberately claim-invisible: claiming the wired side would
draw the *other party's row* into the transaction and emit an update against
it, failing that row's permission when the actor doesn't own it. So the wired
side was unprotected, and destroying it propagates back to the claimed side
through the same wiring.

## The variants (each pinned by a test here)

1. **Pending member of a link array** — the incident itself.
2. **Full-snapshot eviction** — absence-based reconciliation treated absence
   from a full result as a remote hard delete; a pending-new model is absent
   from every result. (Retired outright with that machinery — see the
   stale-race section below.)
3. **Pending link between two persisted models** — a direct many-many link:
   only the pushed side is claimed; the wired side is open, and its
   destruction mutates the claimed side's array before the commit diff runs.
4. **To-one replaced by a pending model** — the snapshot still knows the old
   target and writes it back over the wiring-set replacement; the wiring then
   severs the pending model. (Initially dismissed as unreachable — the real
   server proved otherwise.)

## Designs considered

- **A. Per-site lifecycle guards** — spare pending-new models at each
  reconciliation site. Shipped first; whack-a-mole, and structurally blind to
  variant 3 (both endpoints persisted, only the *link* is pending).
- **B. Hydration shields — chosen.** The wiring registers a shield on every
  field it writes, held by the active transaction and released with the
  claims (`releaseAll`). The hydrator skips shielded fields exactly like
  touched ones. One rule at the single seam every variant passes through;
  covers 1, 3, 4 and retires A.
- **C. Defer/order snapshots** — queue hydration during transactions. Wrong
  without snapshot watermarks (the queued snapshot is still older than the
  commit); correct-but-heavy with them.
- **D. Rebase** — replay in-flight mutations on top of every snapshot
  (latency-compensation style). The principled endgame; a rewrite.

Variant 2 is an eviction, not a field write, so B cannot see it. It was first
guarded with a lifecycle check, then dissolved entirely when absence-based
eviction was removed (below): with no evict verb left, there is nothing to
guard.

The invariant the shields enforce: **reconciliation may only act on state the
server has provably seen.**

Implementation: `reverseLinkWiring.applyReverseChange` (shield registration),
`ScopedTransaction` (`shield`/release; released *before* rollback restoration,
which itself rehydrates through the hydrator), `Model.isFieldShielded`,
`ModelHydrator` (skip shielded).

## The adjacent race: stale results vs. persisted rows — RESOLVED

A subscription result computed *before* a commit can be delivered after its
transact-ok, and absence-based reconciliation then evicted the freshly
committed row as if it were remotely hard-deleted. Scope matters: the app's
`@instantdb/core` reactor is immune — it is local-first, so its results
always include its own writes, and reconnects re-fetch fresh state rather
than replaying stale results. The race lived on **server-computed streams**:
`@instantdb/admin` subscriptions, which back every backend store and
integration-test client.

Reproduction was hard evidence, not hypothesis: with subscribe-before-commit
tests running in parallel with `Transaction.test.ts` on a shared ephemeral
app, 6 of 6 runs failed with a 1:1 correspondence between test failures and
logged evictions of *persisted* rows (11 evictions, ten `users`, one
`posts`), each moments after its own commit.

The underlying truth: absence is only evidence relative to a result whose
scope provably covers the row *and* whose computation provably followed every
local commit. Subscription emissions can never satisfy the second — the
protocol exposes no ordering between an emission's computation and a
transact-ok. A fix approximating that ordering locally (server-sighting flag
plus per-subscription delivery memory) was implemented and validated, then
discarded — as was a pull-only middle ground — for one uniform rule:

**Nothing evicts by absence.** Results — pull or subscription — only add and
update. A model leaves the store exactly two ways: the local transaction
that deleted it, or a row arriving *in* a result with its `deletedAt`
tombstone set (the first phase of every `delete()`, which live watchers
receive as a normal update). This is the semantics the production app always
had — its reactor-backed store never ran absence reconciliation — now made
true for every store.

The accepted residue: a store that isn't watching while the tombstone is
visible (offline across both delete phases, or refreshing only by pull)
keeps the dead model in its identity map until a fresh store boot — reload
the app. Even a live server-computed stream can miss it: `delete()`'s two
commits can coalesce into one recomputation that skips the tombstone state
(observed on CI), so admin-stream subscribers are only guaranteed the
tombstone while it is the final state. The app's reactor is immune — it
receives triple retractions, not recomputed snapshots. Permission
revocation, which never had any signal to miss, lands in the same bucket.
Query return values are built from result rows only and never contain such
ghosts.

Upgrade path if a long-lived store ever needs better: a durable `tombstones`
table (`{entityName, rowId, deletedAt}`, written in the same transact as the
physical delete). It turns deletion from absence into presence — and
presence needs no ordering guarantee: a stale result can lack a tombstone
(learned later, harmless) but never falsely contain one, so even
subscriptions could evict on it. Costs: unbounded growth unless GC'd, and GC
re-opens the missed-window problem at retention scale; permission revocation
still writes no tombstone.
