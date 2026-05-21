export function assertDefined<T>(
  value: T | null | undefined,
  message: string = "expected value to be defined"
): asserts value is NonNullable<T> {
  if (value == null) throw new Error(message);
}
