import type { IEntity } from "../IdentityMap";
import type { EntityName } from "../store/EntityMeta";
import { getEntityMeta } from "../store/EntityMeta";
import { ChangeTracker } from "./ChangeTracker";
import { getDatabase } from "./DatabaseProvider";
import type { TxChunk } from "./types";

const entityTrackers = new WeakMap<IEntity, ChangeTracker>();

export function initializeTracking(
  entity: IEntity,
  entityName: EntityName
): void {
  if (entityTrackers.has(entity)) {
    return;
  }
  const tracker = new ChangeTracker(entity, entityName);
  entityTrackers.set(entity, tracker);
}

export function getTracker(entity: IEntity): ChangeTracker | undefined {
  return entityTrackers.get(entity);
}

export async function saveEntity(
  entity: IEntity,
  entityName: EntityName
): Promise<void> {
  const tracker = entityTrackers.get(entity);
  if (!tracker) {
    throw new Error(
      `Entity ${entityName}:${entity.id} is not being tracked. ` +
        `Call initializeTracking() first.`
    );
  }

  if (!tracker.hasChanges()) {
    return;
  }

  const changes = tracker.getChanges();
  const db = getDatabase();

  let tx: TxChunk = db.tx[entityName][entity.id];

  // Scalar updates
  if (changes.scalars.size > 0) {
    const updateData: Record<string, unknown> = {};
    for (const [field, value] of changes.scalars) {
      updateData[field] = value instanceof Date ? value.toISOString() : value;
    }
    tx = tx.update(updateData);
  }

  // Link operations
  for (const [linkName, ids] of changes.links) {
    // Get the label from the link name
    tx = tx.link({ [getLinkLabel(entityName, linkName)]: ids.length === 1 ? ids[0] : ids });
  }

  // Unlink operations
  for (const [linkName, ids] of changes.unlinks) {
    tx = tx.unlink({ [getLinkLabel(entityName, linkName)]: ids.length === 1 ? ids[0] : ids });
  }

  await db.transact([tx]);

  tracker.reset();
}

function getLinkLabel(entityName: EntityName, linkName: string): string {
  const meta = getEntityMeta(entityName);
  const rel = meta.relationshipFields.find((r) => r.linkName === linkName);
  return rel?.fieldName ?? linkName;
}
