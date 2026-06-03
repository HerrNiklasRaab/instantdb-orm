import { collectFieldDescriptors, getBackingFieldName, type FieldDescriptor } from "./field";
import { syncGlobalState } from "../globalState";
import {
  ColumnCodec,
  LeafCodec,
  type ColumnInfo,
  type StorableValue,
} from "../columns/ColumnCodec";
import type { ColumnReader, ColumnType, ColumnValue, JsonValue, OutColumn } from "../columns/types";
import { camelJoin } from "../columns/types";
import { instantCodec, temporalCodecForCtor } from "../temporal/registry";
import { isTemporal, temporalEquals } from "../temporal/wire";

export { camelJoin };

export enum ValueObjectStorage {
  MultiColumn = "multiColumn",
  SingleColumn = "singleColumn",
  Json = "json",
}

export interface ValueObjectOptions {
  storage?: ValueObjectStorage;
}

export type AnyClass = abstract new (...args: never[]) => unknown;
type ConcreteVOCtor<T extends ValueObject = ValueObject> = new (...args: never[]) => T;

const REGISTRY = (syncGlobalState().valueObjectRegistry ??= new Map<object, ValueObjectClass>());

export function valueObject(options?: ValueObjectOptions) {
  return function <T extends ConcreteVOCtor>(target: T, context: ClassDecoratorContext<T>): T {
    const storage = options?.storage ?? ValueObjectStorage.MultiColumn;
    const klass = new ValueObjectClass(target, storage);
    REGISTRY.set(target, klass);
    // Validation runs after the class's Symbol.metadata is assigned
    // (post-decoration), so `collectFieldDescriptors(target)` can see the
    // @field()-decorated members.
    context.addInitializer(() => {
      klass.validateFields();
    });
    return target;
  };
}

export function getValueObjectClass(ctor: unknown): ValueObjectClass | undefined {
  if (typeof ctor !== "function") return undefined;
  return REGISTRY.get(ctor);
}

export function isValueObjectClass(ctor: unknown): boolean {
  return typeof ctor === "function" && REGISTRY.has(ctor);
}

function makeBlankInstance<T extends ValueObject>(ctor: ConcreteVOCtor<T>): T {
  const proto: unknown = ctor.prototype;
  if (proto === null || typeof proto !== "object") {
    throw new Error("Value object class has no prototype.");
  }
  const created: unknown = Object.create(proto);
  if (!(created instanceof ctor)) {
    throw new Error("Failed to allocate value object instance.");
  }
  return created;
}

// ─── Field: binds a property (name, optionality) to a ColumnCodec ───────────
//
// `Field` is the only thing that touches the holder object's property; the
// codec is purely about value⟷columns. Column names are prefixed with the
// field's `attributeName` (recursing through nested codecs).

export class Field {
  constructor(
    readonly propertyName: string,
    readonly attributeName: string,
    readonly optional: boolean,
    readonly codec: ColumnCodec<StorableValue>
  ) {}

  readValue(holder: object): unknown {
    return Reflect.get(holder, this.propertyName);
  }

  setValue(target: object, value: StorableValue | null): void {
    Reflect.set(target, this.propertyName, value);
  }

  /** Concrete columns this field owns on the holder (name + storage type). */
  columns(parentPrefix: string): readonly ColumnInfo[] {
    return this.codec.columns(camelJoin(parentPrefix, this.attributeName));
  }

  ownedColumns(parentPrefix: string): string[] {
    return this.columns(parentPrefix).map((c) => c.name);
  }

  equals(a: unknown, b: unknown): boolean {
    return this.codec.equals(this.narrow(a), this.narrow(b));
  }


  decomposeSpread(parentPrefix: string, value: unknown, out: OutColumn[]): void {
    this.codec.decompose(camelJoin(parentPrefix, this.attributeName), this.narrow(value), this.optional, out);
  }

  assembleFromSpread(parentPrefix: string, target: object, read: ColumnReader): void {
    this.setValue(target, this.codec.assemble(camelJoin(parentPrefix, this.attributeName), this.optional, read));
  }

  serializeJson(value: unknown): JsonValue {
    return this.codec.toJson(this.narrow(value));
  }

  deserializeJson(raw: unknown): StorableValue | null {
    return this.codec.fromJson(raw, this.optional);
  }

  captureSnapshot(holder: object, parentPrefix: string, scalars: Map<string, unknown>): void {
    const value = this.narrow(this.readValue(holder));
    const out: OutColumn[] = [];
    this.codec.decompose(camelJoin(parentPrefix, this.attributeName), value, this.optional, out);
    for (const col of out) scalars.set(col.columnName, col.value);
  }

  /**
   * Hydrate this field from a partial column set. When not every owned column
   * is present in `rawData`, the absent ones fall back to the holder's current
   * value (so an optimistic partial patch doesn't wipe untouched columns).
   */
  hydrateFromColumns(
    holder: object,
    read: ColumnReader,
    columnPresent: (column: string) => boolean
  ): void {
    const prefix = camelJoin("", this.attributeName);
    const owned = this.codec.columns(prefix);
    // Single-column codecs (scalar leaf, Instant, Duration, JSON-VO) can't be
    // "partially present", so they skip the multi-column merge-fallback path.
    if (owned.length > 1) {
      let allPresent = true;
      for (const col of owned) {
        if (!columnPresent(col.name)) { allPresent = false; break; }
      }
      if (!allPresent) {
        const current = this.narrow(this.readValue(holder));
        if (current !== null) {
          const out: OutColumn[] = [];
          this.codec.decompose(prefix, current, this.optional, out);
          const fallback = new Map<string, ColumnValue>();
          for (const col of out) fallback.set(col.columnName, col.value);
          const merged: ColumnReader = (c) => (columnPresent(c) ? read(c) : fallback.get(c) ?? null);
          this.setValue(holder, this.codec.assemble(prefix, this.optional, merged));
          return;
        }
      }
    }
    this.setValue(holder, this.codec.assemble(prefix, this.optional, read));
  }

  private narrow(value: unknown): StorableValue | null {
    if (value === null || value === undefined) return null;
    if (this.codec.accepts(value)) return value;
    return scalarValue(value);
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value).every(isJsonValue);
  return false;
}

/** Narrow an untyped raw value to a `ColumnValue` via guards (no `as`). */
function scalarValue(value: NonNullable<unknown>): ColumnValue {
  if (isJsonValue(value)) return value;
  throw new Error(`Unsupported column value of type ${typeof value}.`);
}

// ─── ScalarCodec: passthrough for a raw, undecorated-type field ─────────────

export class ScalarCodec extends LeafCodec<ColumnValue> {
  constructor(readonly columnType: ColumnType = "scalar") {
    super();
  }
  override accepts(value: unknown): value is ColumnValue {
    return value !== undefined;
  }
  protected encode(value: ColumnValue): ColumnValue {
    return value;
  }
  protected decode(raw: NonNullable<unknown>): ColumnValue {
    return scalarValue(raw);
  }
  override equals(a: ColumnValue | null, b: ColumnValue | null): boolean {
    return scalarOrStructuralEqual(a, b);
  }
}

function scalarOrStructuralEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isTemporal(a) || isTemporal(b)) return temporalEquals(a, b);
  if (a instanceof ValueObject) return a.equals(b);
  if (b instanceof ValueObject) return b.equals(a);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!scalarOrStructuralEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!scalarOrStructuralEqual(Reflect.get(a, k), Reflect.get(b, k))) return false;
    }
    return true;
  }
  return false;
}

// ─── ValueObjectClass: storage-agnostic structural metadata for a VO ────────
//
// Holds the VO's @field() list and the structural operations (equals, canonical
// JSON, blank construction). It does NOT decide storage shape — that is the
// codec chosen per `storage` mode. One class, no per-storage subclasses.

export class ValueObjectClass<T extends ValueObject = ValueObject> {
  private _fields: readonly Field[] | null = null;

  constructor(
    readonly ctor: ConcreteVOCtor<T>,
    readonly storage: ValueObjectStorage
  ) {}

  fields(): readonly Field[] {
    if (this._fields) return this._fields;
    const descriptors = collectFieldDescriptors(this.ctor);
    if (descriptors.length === 0) throw new Error(this.noFieldsError());
    const built = descriptors.map((d) => buildField(d.propertyName, d));
    this._fields = built;
    return built;
  }

  validateFields(): void {
    if (collectFieldDescriptors(this.ctor).length === 0) throw new Error(this.noFieldsError());
    if (this.storage === ValueObjectStorage.SingleColumn) {
      const descriptors = collectFieldDescriptors(this.ctor);
      if (descriptors.length !== 1) {
        throw new Error(
          `ValueObject class '${this.ctor.name}' has storage: 'singleColumn' but ${descriptors.length} @field()s. ` +
            `singleColumn requires exactly one @field().`
        );
      }
      if (descriptors[0]?.type) {
        throw new Error(
          `ValueObject class '${this.ctor.name}' has storage: 'singleColumn' with a nested ValueObject @field(). ` +
            `singleColumn supports only scalar fields.`
        );
      }
    }
  }

  private noFieldsError(): string {
    const name = this.ctor.name || "<anonymous>";
    return `ValueObject class '${name}' has no \`@field()\`-decorated fields. Every field must be decorated with \`@field()\` so the framework can discover it.`;
  }

  isInstance(value: unknown): value is T {
    return value instanceof this.ctor;
  }

  blank(): T {
    return makeBlankInstance(this.ctor);
  }

  equals(a: T, b: unknown): boolean {
    if ((a as unknown) === b) return true;
    if (b === null || typeof b !== "object") return false;
    if (Object.getPrototypeOf(b) !== Object.getPrototypeOf(a)) return false;
    for (const f of this.fields()) {
      if (!f.equals(f.readValue(a), f.readValue(b))) return false;
    }
    return true;
  }

  serializeAsJson(instance: T): { [key: string]: JsonValue } {
    const out: { [key: string]: JsonValue } = {};
    for (const f of this.fields()) {
      out[f.attributeName] = f.serializeJson(f.readValue(instance));
    }
    return out;
  }

  hydrateFromJsonObject(raw: unknown, _fieldOptional: boolean): T | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "object") {
      throw new Error(`Value object: expected object for JSON column, got ${typeof raw}.`);
    }
    const source: object = raw;
    const target = this.blank();
    for (const f of this.fields()) {
      f.setValue(target, f.deserializeJson(Reflect.get(source, f.attributeName)));
    }
    Object.freeze(target);
    return target;
  }
}

// ─── VO codecs: one per storage mode, all ColumnCodec<ValueObject> ──────────

/** Wraps exactly one scalar `@field()` in a single column named after the
 * holder (no inner suffix). For typed wrappers like EmailAddress / Slug. */
class SingleColumnCodec extends LeafCodec<ValueObject> {
  readonly columnType: ColumnType = "scalar";
  constructor(private readonly voClass: ValueObjectClass) {
    super();
  }
  override accepts(value: unknown): value is ValueObject {
    return this.voClass.isInstance(value);
  }
  protected encode(value: ValueObject): ColumnValue {
    const field = this.voClass.fields()[0];
    if (!field) throw new Error("singleColumn VO has no field.");
    return scalarValue(asNonNull(field.readValue(value)));
  }
  protected decode(raw: NonNullable<unknown>): ValueObject {
    const target = this.voClass.blank();
    const field = this.voClass.fields()[0];
    if (!field) throw new Error("singleColumn VO has no field.");
    field.setValue(target, scalarValue(raw));
    Object.freeze(target);
    return target;
  }
  override equals(a: ValueObject | null, b: ValueObject | null): boolean {
    return voEquals(this.voClass, a, b);
  }
}

/** Serializes the whole VO to one `i.json()` column. For variable-arity VOs. */
class JsonObjectCodec extends LeafCodec<ValueObject> {
  readonly columnType: ColumnType = "json";
  constructor(private readonly voClass: ValueObjectClass) {
    super();
  }
  override accepts(value: unknown): value is ValueObject {
    return this.voClass.isInstance(value);
  }
  protected encode(value: ValueObject): ColumnValue {
    return this.voClass.serializeAsJson(value);
  }
  protected decode(raw: NonNullable<unknown>): ValueObject {
    const hydrated = this.voClass.hydrateFromJsonObject(raw, false);
    if (hydrated === null) throw new Error("JSON VO hydration produced null for non-null column.");
    return hydrated;
  }
  override toJson(value: ValueObject | null): JsonValue {
    return value === null ? null : this.voClass.serializeAsJson(value);
  }
  override fromJson(raw: unknown, holderOptional: boolean): ValueObject | null {
    return this.voClass.hydrateFromJsonObject(raw, holderOptional);
  }
  override equals(a: ValueObject | null, b: ValueObject | null): boolean {
    return voEquals(this.voClass, a, b);
  }
}

/** Flattens a fixed-arity VO across multiple columns (one per leaf field,
 * recursing through nested VOs/Temporals). The default storage. */
class SpreadCodec extends ColumnCodec<ValueObject> {
  constructor(private readonly voClass: ValueObjectClass) {
    super();
  }

  override accepts(value: unknown): value is ValueObject {
    return this.voClass.isInstance(value);
  }

  override columns(prefix: string): readonly ColumnInfo[] {
    const out: ColumnInfo[] = [];
    for (const f of this.voClass.fields()) out.push(...f.columns(prefix));
    return out;
  }

  override decompose(prefix: string, value: ValueObject | null, holderOptional: boolean, out: OutColumn[]): void {
    if (value === null) {
      for (const f of this.voClass.fields()) {
        for (const col of f.columns(prefix)) {
          out.push({ columnName: col.name, value: null, optional: holderOptional || f.optional });
        }
      }
      return;
    }
    for (const f of this.voClass.fields()) f.decomposeSpread(prefix, f.readValue(value), out);
  }

  override assemble(prefix: string, _holderOptional: boolean, read: ColumnReader): ValueObject | null {
    const fields = this.voClass.fields();
    const requiredFields = fields.filter((f) => !f.optional);

    let anyRequiredNull = false;
    let anyRequiredNonNull = false;
    for (const f of requiredFields) {
      let fieldNull = true;
      for (const col of f.columns(prefix)) {
        const v: unknown = read(col.name);
        if (v !== null && v !== undefined) fieldNull = false;
      }
      if (fieldNull) anyRequiredNull = true;
      else anyRequiredNonNull = true;
    }

    if (requiredFields.length === 0) {
      let allNull = true;
      for (const f of fields) {
        for (const col of f.columns(prefix)) {
          const v: unknown = read(col.name);
          if (v !== null && v !== undefined) { allNull = false; break; }
        }
        if (!allNull) break;
      }
      if (allNull) return null;
    } else if (anyRequiredNull && !anyRequiredNonNull) {
      return null;
    }

    const target = this.voClass.blank();
    for (const f of fields) f.assembleFromSpread(prefix, target, read);
    Object.freeze(target);
    return target;
  }

  override equals(a: ValueObject | null, b: ValueObject | null): boolean {
    return voEquals(this.voClass, a, b);
  }

  override toJson(value: ValueObject | null): JsonValue {
    return value === null ? null : this.voClass.serializeAsJson(value);
  }

  override fromJson(raw: unknown, holderOptional: boolean): ValueObject | null {
    return this.voClass.hydrateFromJsonObject(raw, holderOptional);
  }
}

function voEquals(voClass: ValueObjectClass, a: ValueObject | null, b: ValueObject | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return voClass.equals(a, b);
}

function asNonNull(value: unknown): NonNullable<unknown> {
  if (value === null || value === undefined) throw new Error("singleColumn VO field value is null.");
  return value;
}

function codecForValueObject(voClass: ValueObjectClass): ColumnCodec<StorableValue> {
  switch (voClass.storage) {
    case ValueObjectStorage.Json:
      return new JsonObjectCodec(voClass);
    case ValueObjectStorage.SingleColumn:
      return new SingleColumnCodec(voClass);
    case ValueObjectStorage.MultiColumn:
      return new SpreadCodec(voClass);
  }
}

/** Resolve a `@field()` descriptor to its codec: VO, Temporal, or raw scalar. */
function codecFor(d: FieldDescriptor | undefined): ColumnCodec<StorableValue> {
  if (d?.type) {
    const voClass = getValueObjectClass(d.type);
    if (voClass) return codecForValueObject(voClass);
    const temporal = temporalCodecForCtor(d.type);
    if (temporal) return temporal;
  }
  return new ScalarCodec();
}

function buildField(propertyName: string, d: FieldDescriptor | undefined): Field {
  const attributeName = d?.attributeName ?? propertyName;
  const optional = d?.optional ?? false;
  return new Field(propertyName, attributeName, optional, codecFor(d));
}

// ─── ValueObject base class ────────────────────────────────────────────────

export abstract class ValueObject {
  equals(other: unknown): boolean {
    return requireClass(this.constructor).equals(this, other);
  }

  key(): string {
    return JSON.stringify(this.toCanonical());
  }

  abstract toString(): string;

  protected toCanonical(): unknown {
    return requireClass(this.constructor).serializeAsJson(this);
  }
}

function requireClass(ctor: unknown): ValueObjectClass {
  const klass = getValueObjectClass(ctor);
  if (!klass) {
    const name = typeof ctor === "function" ? ctor.name : String(ctor);
    throw new Error(`ValueObject subclass '${name}' is missing the @valueObject() decorator.`);
  }
  return klass;
}

// ─── Model-side field collection ────────────────────────────────────────────

/** Composed fields (VO or Temporal) declared via `@field({ type })`. Internal
 * to `collectAllFields` (its sole caller, itself cached), so no memoization
 * here — it runs at most once per ModelClass. */
function collectComposedFields(ModelClass: object): Field[] {
  const out: Field[] = [];
  for (const d of collectFieldDescriptors(ModelClass)) {
    if (!d.type) continue;
    if (!getValueObjectClass(d.type) && !temporalCodecForCtor(d.type)) continue;
    out.push(buildField(d.propertyName, d));
  }
  return out;
}

const ALL_FIELDS_CACHE = new WeakMap<object, Map<string, Field>>();

/** The scalar/date/json valueType InstantDB reports for a column. */
export interface AttrValueType {
  readonly column: string;
  readonly valueType: string;
}

/**
 * One `Field` per schema column: a declared composed field (VO/Temporal) where
 * present, otherwise a default-codec field by `valueType` (`date` →
 * Temporal.Instant, `json`/scalar → passthrough). This is the single field set
 * the persistence layer iterates — there is no separate "raw column" path, so
 * every column's read/write goes through a codec.
 *
 * Cached per (ModelClass × attr-set) since attrs are stable for an entity.
 */
export function collectAllFields(ModelClass: object, attrs: readonly AttrValueType[]): Field[] {
  const cached = ALL_FIELDS_CACHE.get(ModelClass);
  if (cached) return [...cached.values()];

  const composed = collectComposedFields(ModelClass);
  const ownedColumns = new Set<string>();
  for (const f of composed) {
    for (const col of f.ownedColumns("")) ownedColumns.add(col);
  }

  const byProp = new Map<string, Field>();
  for (const f of composed) byProp.set(f.propertyName, f);

  for (const { column, valueType } of attrs) {
    if (column === "id" || column === "modelType") continue;
    if (ownedColumns.has(column)) continue;
    const propertyName = getBackingFieldName(ModelClass, column) ?? column;
    if (byProp.has(propertyName)) continue;
    byProp.set(propertyName, new Field(propertyName, column, false, defaultCodecForValueType(valueType)));
  }

  ALL_FIELDS_CACHE.set(ModelClass, byProp);
  return [...byProp.values()];
}

function defaultCodecForValueType(valueType: string): ColumnCodec<StorableValue> {
  if (valueType === "date") return instantCodec();
  return new ScalarCodec(valueType === "json" ? "json" : "scalar");
}
