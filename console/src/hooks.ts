import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
export function useResource<T = any>(path: string | null, retainOnRefresh = false) {
  const [result, setResult] = useState<{ path: string; data: T } | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(!!path),
    [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) {
      setResult(null);
      setError('');
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    if (!retainOnRefresh) setResult(null);
    api<T>(path, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setResult({ path, data });
        setLoading(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted && e.name !== 'AbortError') {
          // A failed authorization or refresh must never leave an editable stale record.
          setResult(null);
          setError(e.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [path, tick, retainOnRefresh]);
  const setData = useCallback(
    (data: T | null) => setResult(path && data !== null ? { path, data } : null),
    [path],
  );
  return {
    // Synchronous path gating prevents even one render of another tenant/location's data.
    data: result?.path === path ? result.data : null,
    error,
    loading,
    reload: useCallback(() => setTick((t) => t + 1), []),
    setData,
  };
}
export type Run = (name: string, fn: () => Promise<void>) => Promise<void>;
