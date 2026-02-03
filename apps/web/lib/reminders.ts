"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

export type ReminderStatus = "active" | "completed" | "canceled";
export type ReminderBucket = "overdue" | "today" | "soon" | "later";

export type ReminderOverviewRow = {
  id: string;
  title: string;
  note: string | null;
  media: { id: string; title: string } | null;
  effectiveDueAt: string;
  remindAt: string;
  snoozedUntil: string | null;
  bucket: ReminderBucket;
  isOverdue: boolean;
};

export type RemindersSummary = {
  visibleNow: number;
  overdue: number;
  dueToday: number;
  dueSoon: number;
  totalActive: number;
  soonWindowDays: number;
};

type QueryKey = readonly unknown[];

type CacheEntry = {
  key: QueryKey;
  data: unknown;
};

const cache = new Map<string, CacheEntry>();
const listeners = new Map<string, Set<() => void>>();

function serializeKey(key: QueryKey) {
  return JSON.stringify(key);
}

function deepEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPrefixKey(key: QueryKey, prefix: QueryKey) {
  if (prefix.length > key.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (!deepEqual(key[index], prefix[index])) return false;
  }
  return true;
}

function subscribe(key: QueryKey, listener: () => void) {
  const keyString = serializeKey(key);
  const existing = listeners.get(keyString);
  if (existing) {
    existing.add(listener);
  } else {
    listeners.set(keyString, new Set([listener]));
  }

  return () => {
    const next = listeners.get(keyString);
    if (!next) return;
    next.delete(listener);
    if (next.size === 0) listeners.delete(keyString);
  };
}

function notifyKey(key: QueryKey) {
  const keyString = serializeKey(key);
  const keyListeners = listeners.get(keyString);
  if (!keyListeners) return;
  for (const listener of keyListeners) listener();
}

function setCacheData<T>(key: QueryKey, data: T) {
  cache.set(serializeKey(key), { key, data });
  notifyKey(key);
}

function invalidateByPrefix(prefix: QueryKey) {
  for (const [keyString, entry] of cache.entries()) {
    if (!isPrefixKey(entry.key, prefix)) continue;
    cache.delete(keyString);
    notifyKey(entry.key);
  }
}

function updateOverviewCaches(updater: (rows: ReminderOverviewRow[]) => ReminderOverviewRow[]) {
  for (const entry of cache.values()) {
    if (!isPrefixKey(entry.key, ["reminders", "overview"])) continue;
    const data = entry.data as { items?: ReminderOverviewRow[] } | null;
    if (!data || !Array.isArray(data.items)) continue;
    const nextItems = updater(data.items);
    if (nextItems === data.items) continue;
    setCacheData(entry.key, { ...data, items: nextItems });
  }
}

function optimisticRemoveOverviewRow(reminderId: string) {
  updateOverviewCaches(items => items.filter(item => item.id !== reminderId));
}

async function readError(response: Response) {
  try {
    const data = (await response.json()) as { message?: string; error?: string } | null;
    if (data?.message) return data.message;
    if (data?.error) return data.error;
  } catch {
    // ignore
  }
  return `Request failed (${response.status})`;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers,
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return undefined as T;
  return (await response.json()) as T;
}

function useCachedQuery<T>(key: QueryKey, fetcher: () => Promise<T>) {
  const keyString = useMemo(() => serializeKey(key), [key]);
  const cachedValue = cache.get(keyString)?.data as T | undefined;
  const [data, setData] = useState<T | undefined>(cachedValue);
  const [loading, setLoading] = useState(cachedValue === undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    return subscribe(key, () => setVersion(current => current + 1));
  }, [key]);

  useEffect(() => {
    let active = true;

    const cached = cache.get(keyString)?.data as T | undefined;
    if (cached !== undefined) {
      setData(cached);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(undefined);

    fetcher()
      .then(result => {
        if (!active) return;
        setCacheData(key, result);
        setData(result);
      })
      .catch(err => {
        if (!active) return;
        setError(err);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [fetcher, key, keyString, version]);

  return { data, loading, error };
}

function getBrowserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

const REMINDERS_SUMMARY_KEY = ["reminders", "summary"] as const;

function overviewKey(limit: number) {
  return ["reminders", "overview", { limit }] as const;
}

function invalidateReminderQueries() {
  invalidateByPrefix(REMINDERS_SUMMARY_KEY);
  invalidateByPrefix(["reminders", "overview"]);
}

type MutationState<TArgs, TData> = {
  isPending: boolean;
  error: string | null;
  mutateAsync: (args: TArgs) => Promise<TData>;
};

function useReminderMutation<TArgs, TData>(
  mutation: (args: TArgs) => Promise<TData>,
): MutationState<TArgs, TData> {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutateAsync = useCallback(
    async (args: TArgs) => {
      setIsPending(true);
      setError(null);
      try {
        return await mutation(args);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Request failed";
        setError(message);
        throw err;
      } finally {
        setIsPending(false);
      }
    },
    [mutation],
  );

  return { isPending, error, mutateAsync };
}

export function useRemindersSummary() {
  const fetchSummary = useCallback(
    () => requestJson<RemindersSummary>("/api/reminders/summary", { method: "GET" }),
    [],
  );
  return useCachedQuery(REMINDERS_SUMMARY_KEY, fetchSummary);
}

export function useOverviewReminders(limit: number) {
  const key = useMemo(() => overviewKey(limit), [limit]);
  const fetchOverview = useCallback(
    () =>
      requestJson<{ items: ReminderOverviewRow[] }>(
        `/api/reminders?status=active&view=overview&limit=${encodeURIComponent(String(limit))}`,
        { method: "GET" },
      ),
    [limit],
  );
  return useCachedQuery(key, fetchOverview);
}

export type CreateReminderInput = {
  title: string;
  note?: string | null;
  mediaId?: string | null;
  dueAt: string;
  remindOffsetDays?: number | null;
  rrule?: string | null;
};

export function useCreateReminder() {
  return useReminderMutation(async (payload: CreateReminderInput) => {
    const timezone = getBrowserTimezone();
    const response = await requestJson<{ reminder: unknown }>("/api/reminders", {
      method: "POST",
      headers: { "x-timezone": timezone },
      body: JSON.stringify(payload),
    });
    invalidateReminderQueries();
    return response;
  });
}

export type UpdateReminderInput = {
  id: string;
  title?: string;
  note?: string | null;
  mediaId?: string | null;
  dueAt?: string;
  remindOffsetDays?: number | null;
  rrule?: string | null;
};

export function useUpdateReminder() {
  return useReminderMutation(async ({ id, ...payload }: UpdateReminderInput) => {
    const response = await requestJson<{ reminder: unknown }>(`/api/reminders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    invalidateReminderQueries();
    return response;
  });
}

export function useCompleteReminder() {
  return useReminderMutation(async ({ id }: { id: string }) => {
    optimisticRemoveOverviewRow(id);
    try {
      return await requestJson<{ ok: boolean }>(`/api/reminders/${id}/complete`, {
        method: "POST",
      });
    } finally {
      invalidateReminderQueries();
    }
  });
}

export function useSnoozeReminder() {
  return useReminderMutation(async ({ id, until }: { id: string; until: string }) => {
    optimisticRemoveOverviewRow(id);
    try {
      return await requestJson<{ ok: boolean }>(`/api/reminders/${id}/snooze`, {
        method: "POST",
        body: JSON.stringify({ until }),
      });
    } finally {
      invalidateReminderQueries();
    }
  });
}

export function useCancelReminder() {
  return useReminderMutation(async ({ id }: { id: string }) => {
    const response = await requestJson<{ ok: boolean }>(`/api/reminders/${id}/cancel`, {
      method: "POST",
    });
    invalidateReminderQueries();
    return response;
  });
}
