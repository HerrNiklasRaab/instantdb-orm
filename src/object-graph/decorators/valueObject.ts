import { collectFieldDescriptors, type FieldDescriptor } from "./field";

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

const REGISTRY = new Map<object, ValueObjectClass>();
const MODEL_FIELDS_CACHE = new WeakMap<object, ValueObjectField[]>();

export function valueObject(options?: ValueObjectOptions) {
  return function <T extends ConcreteVOCtor>(target: T): T {
    const storage = options?.storage ?? ValueObjectStorage.MultiColumn;
    let klass: ValueObjectClass;
    switch (storage) {
      case ValueObjectStorage.Json:
        klass = new JsonValueObjectClass(target);
        break;
      case ValueObjectStorage.SingleColumn:
        klass = new SingleColumnValueObjectClass(target);
        break;
      case ValueObjectStorage.MultiColumn:
      default:
        klass = new SpreadValueObjectClass(target);
        break;
    }
    REGISTRY.set(target, klass);
    klass.validateFields();
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

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function camelJoin(prefix: string, suffix: string): string {
  if (suffix.length === 0) return prefix;
  if (prefix.length === 0) return suffix;
  return prefix + capitalize(suffix);
}

export interface SpreadColumn {
  readonly columnName: string;
  readonly value: unknown;
  readonly optional: boolean;
}

function scalarOrStructuralEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof ValueObject) return a.equals(b);
  if (b instanceof ValueObject) return b.equals(a);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!scalarOrStructuralEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (
    a !== null && b !== null &&
    typeof a === "object" && typeof b === "object"
  ) {
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

export abstract class Field {
  constructor(
    readonly propertyName: string,
    readonly attributeName: string,
    readonly optional: boolean
  ) {}

  readValue(holder: object): unknown {
    return Reflect.get(holder, this.propertyName);
  }

  setValue(target: object, value: unknown): void {
    Reflect.set(target, this.propertyName, value);
  }

  abstract ownedColumns(parentPrefix: string): string[];
  abstract equals(a: unknown, b: unknown): boolean;
  abstract serializeJson(value: unknown): unknown;
  abstract deserializeJson(raw: unknown, fieldOptional: boolean): unknown;

  abstract decomposeSpread(
    parentPrefix: string,
    value: unknown,
    out: SpreadColumn[]
  ): void;

  abstract assembleFromSpread(
    parentPrefix: string,
    target: object,
    readColumn: (column: string) => unknown
  ): void;

  captureSnapshot(holder: object, parentPrefix: string, scalars: Map<string, unknown>): void {
    const value: unknown = this.readValue(holder);
    if (value == null) {
      for (const col of this.ownedColumns(parentPrefix)) scalars.set(col, null);
      return;
    }
    const out: SpreadColumn[] = [];
    this.decomposeSpread(parentPrefix, value, out);
    for (const col of out) scalars.set(col.columnName, col.value);
  }
}

export class ScalarField extends Field {
  override ownedColumns(parentPrefix: string): string[] {
    return [camelJoin(parentPrefix, this.attributeName)];
  }

  override equals(a: unknown, b: unknown): boolean {
    return scalarOrStructuralEqual(a, b);
  }

  override serializeJson(value: unknown): unknown {
    return value;
  }

  override deserializeJson(raw: unknown, _fieldOptional: boolean): unknown {
    return raw ?? null;
  }

  override decomposeSpread(
    parentPrefix: string,
    value: unknown,
    out: SpreadColumn[]
  ): void {
    out.push({
      columnName: camelJoin(parentPrefix, this.attributeName),
      value,
      optional: this.optional,
    });
  }

  override assembleFromSpread(
    parentPrefix: string,
    target: object,
    readColumn: (column: string) => unknown
  ): void {
    const raw: unknown = readColumn(camelJoin(parentPrefix, this.attributeName));
    this.setValue(target, raw ?? null);
  }
}

export class ValueObjectField extends Field {
  constructor(
    propertyName: string,
    attributeName: string,
    optional: boolean,
    readonly voClass: ValueObjectClass
  ) {
    super(propertyName, attributeName, optional);
  }

  override ownedColumns(parentPrefix: string): string[] {
    const childPrefix = camelJoin(parentPrefix, this.attributeName);
    return this.voClass.ownedColumns(childPrefix);
  }

  override equals(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a instanceof ValueObject) return a.equals(b);
    if (b instanceof ValueObject) return b.equals(a);
    return false;
  }

  override serializeJson(value: unknown): Record<string, unknown> | null {
    if (!(value instanceof ValueObject)) return null;
    return this.voClass.serializeAsJson(value);
  }

  override deserializeJson(raw: unknown, _fieldOptional: boolean): ValueObject | null {
    if (this.voClass.mode === "json") {
      return this.voClass.hydrateFromJson(raw, this.optional);
    }
    if (raw == null) {
      if (this.optional) return null;
      throw new Error(
        `Value object integrity violation: missing nested object for field '${this.propertyName}'.`
      );
    }
    return this.voClass.hydrateFromJson(raw, false);
  }

  override decomposeSpread(
    parentPrefix: string,
    value: unknown,
    out: SpreadColumn[]
  ): void {
    const childPrefix = camelJoin(parentPrefix, this.attributeName);
    this.voClass.decomposeIntoSpread(childPrefix, value, this.optional, out);
  }

  override assembleFromSpread(
    parentPrefix: string,
    target: object,
    readColumn: (column: string) => unknown
  ): void {
    const childPrefix = camelJoin(parentPrefix, this.attributeName);
    const value = this.voClass.assembleFromSpread(childPrefix, this.optional, readColumn);
    this.setValue(target, value);
  }

  hydrateFromColumns(
    target: object,
    readColumn: (column: string) => unknown,
    columnPresent: (column: string) => boolean
  ): void {
    const ownedCols = this.ownedColumns("");
    const allPresent = ownedCols.every((c) => columnPresent(c));
    let effectiveRead = readColumn;
    if (!allPresent) {
      const currentValue: unknown = Reflect.get(target, this.propertyName);
      if (currentValue instanceof ValueObject) {
        const out: SpreadColumn[] = [];
        this.voClass.decomposeIntoSpread("", currentValue, false, out);
        const currentColumns = new Map<string, unknown>();
        for (const col of out) currentColumns.set(col.columnName, col.value);
        effectiveRead = (c) => columnPresent(c) ? readColumn(c) : (currentColumns.get(c) ?? null);
      }
    }
    this.assembleFromSpread("", target, effectiveRead);
  }
}

export abstract class ValueObjectClass<T extends ValueObject = ValueObject> {
  protected _fields: readonly Field[] | null = null;

  constructor(readonly ctor: ConcreteVOCtor<T>) {}

  abstract readonly mode: "spread" | "singleColumn" | "json";

  fields(): readonly Field[] {
    if (this._fields) return this._fields;
    const descriptors = collectFieldDescriptors(this.ctor);
    if (descriptors.length === 0) {
      throw new Error(this.noFieldsError());
    }
    const built = descriptors.map((d) => buildField(d.propertyName, d));
    this._fields = built;
    return built;
  }

  validateFields(): void {
    if (collectFieldDescriptors(this.ctor).length === 0) {
      throw new Error(this.noFieldsError());
    }
  }

  private noFieldsError(): string {
    const name = this.ctor.name || "<anonymous>";
    return `ValueObject class '${name}' has no \`@field()\`-decorated fields. Every field must be decorated with \`@field()\` so the framework can discover it.`;
  }

  abstract ownedColumns(prefix: string): string[];

  equals(a: T, b: unknown): boolean {
    if (a === b) return true;
    if (b === null || typeof b !== "object") return false;
    if (Object.getPrototypeOf(b) !== Object.getPrototypeOf(a)) return false;
    for (const f of this.fields()) {
      const av: unknown = f.readValue(a);
      const bv: unknown = f.readValue(b);
      if (!f.equals(av, bv)) return false;
    }
    return true;
  }

  serializeAsJson(instance: T): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of this.fields()) {
      const v: unknown = f.readValue(instance);
      out[f.attributeName] = f.serializeJson(v);
    }
    return out;
  }

  hydrateFromJson(raw: unknown, fieldOptional: boolean): T | null {
    if (raw === null || raw === undefined) {
      if (fieldOptional) return null;
      return null;
    }
    if (typeof raw !== "object") {
      throw new Error(
        `Value object: expected object for JSON column, got ${typeof raw}.`
      );
    }
    const source: object = raw;
    const target = makeBlankInstance(this.ctor);
    for (const f of this.fields()) {
      const value: unknown = Reflect.get(source, f.attributeName);
      f.setValue(target, f.deserializeJson(value, fieldOptional));
    }
    Object.freeze(target);
    return target;
  }

  abstract decomposeIntoSpread(
    prefix: string,
    value: unknown,
    holderOptional: boolean,
    out: SpreadColumn[]
  ): void;

  abstract assembleFromSpread(
    prefix: string,
    holderOptional: boolean,
    readColumn: (column: string) => unknown
  ): T | null;
}

function buildField(propertyName: string, d: FieldDescriptor | undefined): Field {
  const attributeName = d?.attributeName ?? propertyName;
  const optional = d?.optional ?? false;
  if (d?.type) {
    const nested = getValueObjectClass(d.type);
    if (nested) {
      return new ValueObjectField(propertyName, attributeName, optional, nested);
    }
  }
  return new ScalarField(propertyName, attributeName, optional);
}

export class SingleColumnValueObjectClass<T extends ValueObject = ValueObject> extends ValueObjectClass<T> {
  override readonly mode = "singleColumn" as const;

  override validateFields(): void {
    super.validateFields();
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

  override ownedColumns(prefix: string): string[] {
    return [prefix];
  }

  override decomposeIntoSpread(
    prefix: string,
    value: unknown,
    holderOptional: boolean,
    out: SpreadColumn[]
  ): void {
    if (value == null || !(value instanceof this.ctor)) {
      out.push({ columnName: prefix, value: null, optional: holderOptional });
      return;
    }
    const field = this.fields()[0];
    if (!field) {
      out.push({ columnName: prefix, value: null, optional: holderOptional });
      return;
    }
    out.push({ columnName: prefix, value: field.readValue(value), optional: holderOptional });
  }

  override assembleFromSpread(
    prefix: string,
    _holderOptional: boolean,
    readColumn: (column: string) => unknown
  ): T | null {
    const raw: unknown = readColumn(prefix);
    if (raw == null) return null;
    const target = makeBlankInstance(this.ctor);
    const field = this.fields()[0];
    if (!field) return null;
    field.setValue(target, raw);
    Object.freeze(target);
    return target;
  }
}

export class JsonValueObjectClass<T extends ValueObject = ValueObject> extends ValueObjectClass<T> {
  override readonly mode = "json" as const;

  override ownedColumns(prefix: string): string[] {
    return [prefix];
  }

  override decomposeIntoSpread(
    prefix: string,
    value: unknown,
    holderOptional: boolean,
    out: SpreadColumn[]
  ): void {
    out.push({
      columnName: prefix,
      value: value instanceof this.ctor ? this.serializeAsJson(value) : null,
      optional: holderOptional,
    });
  }

  override assembleFromSpread(
    prefix: string,
    holderOptional: boolean,
    readColumn: (column: string) => unknown
  ): T | null {
    const raw: unknown = readColumn(prefix);
    return this.hydrateFromJson(raw, holderOptional);
  }

}

export class SpreadValueObjectClass<T extends ValueObject = ValueObject> extends ValueObjectClass<T> {
  override readonly mode = "spread" as const;

  override ownedColumns(prefix: string): string[] {
    return this.spreadColumns(prefix).map((c) => c.columnName);
  }

  spreadColumns(prefix: string): SpreadColumn[] {
    const out: SpreadColumn[] = [];
    this.decomposeInto(prefix, null, out);
    return out;
  }

  decomposeInto(prefix: string, instance: object | null, out: SpreadColumn[]): void {
    for (const f of this.fields()) {
      const value: unknown = instance === null ? null : f.readValue(instance);
      f.decomposeSpread(prefix, value, out);
    }
  }

  override decomposeIntoSpread(
    prefix: string,
    value: unknown,
    holderOptional: boolean,
    out: SpreadColumn[]
  ): void {
    if (value == null) {
      for (const col of this.spreadColumns(prefix)) {
        out.push({
          columnName: col.columnName,
          value: null,
          optional: holderOptional || col.optional,
        });
      }
      return;
    }
    if (typeof value !== "object") return;
    this.decomposeInto(prefix, value, out);
  }

  override assembleFromSpread(
    prefix: string,
    holderOptional: boolean,
    readColumn: (column: string) => unknown
  ): T | null {
    return this.hydrateFromSpread(prefix, holderOptional, readColumn);
  }

  hydrateFromSpread(
    prefix: string,
    _fieldOptional: boolean,
    readColumn: (column: string) => unknown
  ): T | null {
    const allColumns = this.spreadColumns(prefix);
    const requiredColumns = allColumns.filter((c) => !c.optional);

    let anyRequiredNull = false;
    let anyRequiredNonNull = false;
    for (const col of requiredColumns) {
      const v: unknown = readColumn(col.columnName);
      if (v === null || v === undefined) anyRequiredNull = true;
      else anyRequiredNonNull = true;
    }

    if (requiredColumns.length === 0) {
      let allNull = true;
      for (const col of allColumns) {
        const v: unknown = readColumn(col.columnName);
        if (v !== null && v !== undefined) { allNull = false; break; }
      }
      if (allNull) return null;
    } else if (anyRequiredNull && !anyRequiredNonNull) {
      return null;
    }

    const target = makeBlankInstance(this.ctor);
    for (const f of this.fields()) {
      f.assembleFromSpread(prefix, target, readColumn);
    }
    Object.freeze(target);
    return target;
  }
}

export abstract class ValueObject {
  equals(other: unknown): boolean {
    const klass = getValueObjectClass(this.constructor);
    if (!klass) {
      throw new Error(
        `ValueObject subclass '${this.constructor.name}' is missing the @valueObject() decorator.`
      );
    }
    return klass.equals(this, other);
  }

  key(): string {
    return JSON.stringify(this.toCanonical());
  }

  abstract toString(): string;

  protected toCanonical(): unknown {
    const klass = getValueObjectClass(this.constructor);
    if (!klass) {
      throw new Error(
        `ValueObject subclass '${this.constructor.name}' is missing the @valueObject() decorator.`
      );
    }
    return klass.serializeAsJson(this);
  }
}

export function collectModelValueObjectFields(ModelClass: object): ValueObjectField[] {
  const cached = MODEL_FIELDS_CACHE.get(ModelClass);
  if (cached) return cached;
  const out: ValueObjectField[] = [];
  for (const d of collectFieldDescriptors(ModelClass)) {
    if (!d.type) continue;
    const voClass = getValueObjectClass(d.type);
    if (!voClass) continue;
    out.push(new ValueObjectField(d.propertyName, d.attributeName, d.optional, voClass));
  }
  MODEL_FIELDS_CACHE.set(ModelClass, out);
  return out;
}
