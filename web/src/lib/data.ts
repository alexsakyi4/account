import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';

export interface QueryState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (updater: T | ((current: T | null) => T | null)) => void;
}

type QueryKey = string | null;

/** Minimal data-fetching hook with abort handling and manual reload. */
export function useQuery<T>(path: QueryKey, query?: Record<string, string | number | boolean | null | undefined>): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [nonce, setNonce] = useState(0);
  const queryKey = JSON.stringify(query ?? {});
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    api
      .get<T>(path, query, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Something went wrong loading this page.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, queryKey, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return {
    data,
    error,
    loading,
    reload,
    setData: useCallback((updater) => {
      setData((current) => (typeof updater === 'function' ? (updater as (c: T | null) => T | null)(current) : updater));
    }, []),
  };
}

export function useMutation<TInput = unknown, TResult = unknown>(
  fn: (input: TInput) => Promise<TResult>,
): {
  run: (input: TInput) => Promise<TResult | null>;
  loading: boolean;
  error: string | null;
} {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (input: TInput) => {
      setLoading(true);
      setError(null);
      try {
        return await fn(input);
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'That action did not go through.';
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [fn],
  );
  return { run, loading, error };
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.details && typeof err.details === 'object') {
      const details = err.details as Record<string, unknown>;
      const first = Object.values(details).find((v) => typeof v === 'string');
      if (first) return `${err.message} (${String(first)})`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/* ------------------------------------------------------------------ toasts */

export type ToastKind = 'success' | 'error' | 'info';
export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

type ToastListener = (toasts: Toast[]) => void;
let toasts: Toast[] = [];
const listeners = new Set<ToastListener>();
let nextId = 1;

function emit(): void {
  for (const listener of listeners) listener([...toasts]);
}

function push(kind: ToastKind, title: string, description?: string): void {
  const toast: Toast = { id: nextId++, kind, title, description };
  toasts = [...toasts, toast].slice(-4);
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== toast.id);
    emit();
  }, kind === 'error' ? 7000 : 4500);
}

export const toast = {
  success: (title: string, description?: string) => push('success', title, description),
  error: (title: string, description?: string) => push('error', title, description),
  info: (title: string, description?: string) => push('info', title, description),
  dismiss: (id: number) => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  },
  subscribe: (listener: ToastListener): (() => void) => {
    listeners.add(listener);
    listener([...toasts]);
    return () => listeners.delete(listener);
  },
};

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(handle);
  }, [value, delay]);
  return debounced;
}

export async function download(path: string, filename: string): Promise<void> {
  try {
    await api.download(path, filename);
  } catch (err) {
    toast.error('Download failed', errorMessage(err));
  }
}
