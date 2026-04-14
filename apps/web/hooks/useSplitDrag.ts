"use client";

import { useCallback, useEffect, useRef, useState } from 'react';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface UseSplitDragOptions {
  storageKey: string;
  defaultRatio?: number;
  min?: number;
  max?: number;
}

export function useSplitDrag({
  storageKey,
  defaultRatio = 0.5,
  min = 0.1,
  max = 0.9,
}: UseSplitDragOptions): {
  ratio: number;
  isDragging: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
} {
  const [ratio, setRatio] = useState(defaultRatio);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragMoveHandlerRef = useRef<((event: PointerEvent) => void) | null>(null);
  const dragUpHandlerRef = useRef<((event: PointerEvent) => void) | null>(null);

  // Keep current min/max in a ref so callbacks stay stable (empty deps) without stale closures.
  const boundsRef = useRef({ min, max });
  boundsRef.current = { min, max };

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (!stored) return;
      const parsed = Number(stored);
      if (!Number.isFinite(parsed)) return;
      setRatio(clamp(parsed, min, max));
    } catch {
      // Ignore storage read errors.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally run once on mount

  useEffect(() => {
    const handler = (e: Event) => {
      const key = (e as CustomEvent<{ storageKey: string }>).detail?.storageKey;
      if (key === storageKey) setRatio(defaultRatio);
    };
    window.addEventListener('vault:split-reset', handler);
    return () => window.removeEventListener('vault:split-reset', handler);
  }, [storageKey, defaultRatio]);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(ratio));
    } catch {
      // Ignore storage write errors.
    }
  }, [ratio, storageKey]);

  const updateRatioFromPointer = useCallback((clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;
    const { min: minVal, max: maxVal } = boundsRef.current;
    setRatio(clamp((clientY - rect.top) / rect.height, minVal, maxVal));
  }, []); // stable — reads bounds via ref

  const stopSplitDrag = useCallback(() => {
    if (dragMoveHandlerRef.current) {
      window.removeEventListener('pointermove', dragMoveHandlerRef.current);
      dragMoveHandlerRef.current = null;
    }
    if (dragUpHandlerRef.current) {
      window.removeEventListener('pointerup', dragUpHandlerRef.current);
      dragUpHandlerRef.current = null;
    }
    document.body.style.userSelect = '';
    setIsDragging(false);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    updateRatioFromPointer(e.clientY);
    setIsDragging(true);
    document.body.style.userSelect = 'none';

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateRatioFromPointer(moveEvent.clientY);
    };
    const handlePointerUp = () => { stopSplitDrag(); };

    dragMoveHandlerRef.current = handlePointerMove;
    dragUpHandlerRef.current = handlePointerUp;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
  }, [stopSplitDrag, updateRatioFromPointer]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const { min: minVal, max: maxVal } = boundsRef.current;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setRatio(prev => clamp(prev - 0.03, minVal, maxVal));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setRatio(prev => clamp(prev + 0.03, minVal, maxVal));
    }
  }, []);

  useEffect(() => () => { stopSplitDrag(); }, [stopSplitDrag]);

  return { ratio, isDragging, containerRef, onPointerDown, onKeyDown };
}
