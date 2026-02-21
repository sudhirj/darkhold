export async function jsonFetch<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }
  return payload as T;
}

export async function rpcPost<T = unknown>(method: string, params?: unknown): Promise<T> {
  return await jsonFetch<T>('/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
}

export function isThreadNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('thread not found');
}
