export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}
export function requireThat(condition: unknown, status: number, code: string): asserts condition {
  if (!condition) throw new ApiError(status, code);
}
export function text(value: unknown, max = 128): string {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= max, 400, 'invalid_input');
  return value;
}
export function identifier(value: unknown): string {
  const result = text(value);
  requireThat(/^[a-zA-Z0-9_-]+$/.test(result), 400, 'invalid_identifier');
  return result;
}
