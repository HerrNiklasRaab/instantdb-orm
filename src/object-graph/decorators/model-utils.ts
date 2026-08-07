/** Symbol to store entity name on the class */
export const ENTITY_NAME_KEY = Symbol.for("@upfor/sync.entityName");

/**
 * Brands `Model.prototype`, so a model built by one bundle copy is still
 * recognised by another (see Model.ts). Lives here because the decorators need
 * it too and this module is a leaf.
 */
export const MODEL_BRAND = Symbol.for("@upfor/sync.Model");

/**
 * True only for the framework's base class: subclass prototypes inherit the
 * brand but do not own it. Recognising the base by name instead breaks under
 * production bundlers, which mangle `Model` to something like `iy` — every STI
 * subclass then looks like a root class and registers without its
 * discriminator.
 */
export function isModelBaseClass(cls: object): boolean {
  const proto: unknown = Reflect.get(cls, "prototype");
  if (typeof proto !== "object" || proto === null) return false;
  return Object.prototype.hasOwnProperty.call(proto, MODEL_BRAND);
}

/** Derive entity name from class name: User → "users", MatchInvitation → "matchInvitations" */
export function deriveEntityName(className: string): string {
  if (className.startsWith("$")) {
    return "$" + className.slice(1).toLowerCase() + "s";
  }
  // Convert PascalCase to camelCase and add 's' suffix
  const camelCase = className.charAt(0).toLowerCase() + className.slice(1);
  return camelCase + "s";
}
