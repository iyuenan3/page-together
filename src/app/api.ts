export class RequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch('/api/' + path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok) throw new RequestError(response.status, value.code ?? 'request_failed');
  return value as T;
}
