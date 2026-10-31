/**
 * Typed fetch wrapper for the LedgerLine API.
 *
 * - Adds the bearer token, refreshes it once on 401, and clears the session
 *   when the refresh token is gone (so the app can bounce to /login).
 * - Turns `{ error: { code, message } }` into a typed ApiError the UI can show.
 */

const BASE = '/api/v1';
const TOKEN_KEY = 'ledgerline.accessToken';
const TENANT_KEY = 'ledgerline.tenantId';

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(status: number, error: ApiErrorShape) {
    super(error.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = error.code;
    this.details = error.details;
  }
}

export const tokens = {
  get access(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },
  set access(value: string | null) {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  },
  get tenant(): string | null {
    return localStorage.getItem(TENANT_KEY);
  },
  set tenant(value: string | null) {
    if (value) localStorage.setItem(TENANT_KEY, value);
    else localStorage.removeItem(TENANT_KEY);
  },
  clear(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TENANT_KEY);
  },
};

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(listener: Listener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  raw?: boolean;
  retryOn401?: boolean;
}

let refreshing: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: localStorage.getItem('ledgerline.refreshToken') ?? undefined }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { accessToken?: string; refreshToken?: string };
      if (!data.accessToken) return false;
      tokens.access = data.accessToken;
      if (data.refreshToken) localStorage.setItem('ledgerline.refreshToken', data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => {
        refreshing = null;
      }, 0);
    }
  })();
  return refreshing;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function dispatch<T>(path: string, options: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  const token = tokens.access;
  if (token) headers.authorization = `Bearer ${token}`;
  if (tokens.tenant) headers['x-tenant-id'] = tokens.tenant;
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) body = options.body;
  else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const res = await fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers,
    body,
    credentials: 'include',
    signal: options.signal,
  });

  if (res.status === 401 && options.retryOn401 !== false && !path.startsWith('/auth/')) {
    const refreshed = await refreshSession();
    if (refreshed) return dispatch<T>(path, { ...options, retryOn401: false });
    tokens.clear();
    for (const listener of unauthorizedListeners) listener();
  }

  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    let payload: ApiErrorShape = { code: `http_${res.status}`, message: res.statusText || 'Request failed' };
    if (contentType.includes('application/json')) {
      const parsed = (await res.json().catch(() => null)) as { error?: ApiErrorShape } | null;
      if (parsed?.error) payload = parsed.error;
    }
    if (res.status === 401) {
      tokens.clear();
      for (const listener of unauthorizedListeners) listener();
    }
    throw new ApiError(res.status, payload);
  }

  if (options.raw) return res as unknown as T;
  if (contentType.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    dispatch<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown, options?: Partial<RequestOptions>) =>
    dispatch<T>(path, { method: 'POST', body, ...options }),
  patch: <T>(path: string, body?: unknown) => dispatch<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => dispatch<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => dispatch<T>(path, { method: 'DELETE' }),
  download: async (path: string, filename: string) => {
    const blob = await dispatch<Blob>(path, { method: 'GET', raw: true });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
  },
};

export interface Paginated<T> {
  data: T[];
  pagination?: { page: number; pageSize: number; total: number; totalPages: number; hasMore: boolean };
}
