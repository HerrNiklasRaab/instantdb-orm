export function firstOrFail<T>(
  arr: readonly T[],
  message: string = "expected array to have at least one element",
): T {
  const first = arr[0];
  if (first === undefined) throw new Error(message);
  return first;
}
