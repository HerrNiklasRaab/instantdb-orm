import type { FieldDef, ModelDef, SchemaDef } from "@zenstackhq/schema";
import { SyncSchema } from "../schema/SyncSchema";

/**
 * The app's schema as this device holds it: the server's models and
 * columns, loosened only where what the device is sent differs from what the
 * server stores.
 *
 * - A field the server may withhold (a field-level read policy) is optional
 *   here whatever the server's column says: a row arrives without it.
 *   `HiddenFields` tells a withheld value from an empty one.
 * - Foreign keys are not enforced: a row may point at one this device was
 *   never sent.
 * - The device's own bookkeeping (`hiddenFields`, `bucketCursors`, from
 *   `client.zmodel`) exists only here.
 *
 * The tables are created from it once, when the replica is first opened;
 * nothing migrates a replica created under an earlier schema.
 */
export class ReplicaSchema {
  private constructor(readonly def: SchemaDef) {}

  static of(schema: SchemaDef): ReplicaSchema {
    const guarded = SyncSchema.of(schema).guarded;
    const models: Record<string, ModelDef> = {};
    for (const [name, model] of Object.entries(schema.models)) {
      const withheld = guarded.get(name) ?? [];
      const fields: Record<string, FieldDef> = {};
      for (const [fieldName, field] of Object.entries(model.fields)) {
        fields[fieldName] = withheld.includes(fieldName) ? { ...field, optional: true } : field;
      }
      models[name] = { ...model, fields };
    }
    return new ReplicaSchema({ ...schema, models });
  }
}
