"use client";

import { useEffect, useRef } from "react";
import { isMediaEventField, type MediaEvent } from "@vault/types";

type UseMediaEventsOptions = {
  /** Called for every parsed event from the stream. */
  onEvent: (event: MediaEvent) => void;
  /**
   * Called on every successful (re)connect. Use it to refetch state that may
   * have changed while disconnected — Redis pub/sub has no backlog, so events
   * published during downtime are gone.
   */
  onConnect?: () => void;
};

/**
 * Subscribe to the server's media event stream (/api/media/events).
 *
 * Owns the EventSource lifecycle: connect on mount, manual exponential backoff
 * on errors (2 s → 60 s — the browser's built-in ~3 s fixed retry hammers the
 * port during server restarts), teardown on unmount. Callbacks are kept in
 * refs, so passing inline closures never causes a reconnect.
 */
export function useMediaEvents({ onEvent, onConnect }: UseMediaEventsOptions) {
  const onEventRef = useRef(onEvent);
  const onConnectRef = useRef(onConnect);
  useEffect(() => {
    onEventRef.current = onEvent;
    onConnectRef.current = onConnect;
  });

  useEffect(() => {
    let es: EventSource | null = null;
    let retryDelay = 2_000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let unmounted = false;

    const connect = () => {
      if (unmounted) return;
      es = new EventSource("/api/media/events");

      es.onopen = () => {
        retryDelay = 2_000; // reset backoff on successful connect
        onConnectRef.current?.();
      };

      es.onmessage = (e: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(e.data) as { mediaId?: string; field?: string; value?: string };
          if (!parsed.mediaId || !parsed.field || !parsed.value) return;
          if (!isMediaEventField(parsed.field)) return;
          onEventRef.current({ mediaId: parsed.mediaId, field: parsed.field, value: parsed.value });
        } catch {
          // ignore malformed frames
        }
      };

      es.onerror = () => {
        es?.close();
        es = null;
        if (!unmounted) {
          retryTimer = setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 60_000);
        }
      };
    };

    connect();

    return () => {
      unmounted = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      es?.close();
    };
  }, []);
}
