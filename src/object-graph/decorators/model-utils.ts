/** Symbol to store entity name on the class */
export const ENTITY_NAME_KEY = Symbol("entityName");

/** Derive entity name from class name: User → "users", MatchRequest → "matchRequests" */
export function deriveEntityName(className: string): string {
  if (className.startsWith("$")) {
    return "$" + className.slice(1).toLowerCase() + "s";
  }
  // Convert PascalCase to camelCase and add 's' suffix
  const camelCase = className.charAt(0).toLowerCase() + className.slice(1);
  return camelCase + "s";
}
