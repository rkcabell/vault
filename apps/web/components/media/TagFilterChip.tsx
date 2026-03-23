import { cn } from '@/lib/utils';

export type TagFilterState = 'unselected' | 'include' | 'exclude';

interface TagFilterChipProps {
  tag: string;
  state: TagFilterState;
  onCycle: (tag: string) => void;
  color?: string | null;
  count?: number;
  className?: string;
}

export function TagFilterChip({ tag, state, onCycle, color, count, className }: TagFilterChipProps) {
  return (
    <button
      type="button"
      onClick={() => onCycle(tag)}
      title={
        state === 'include' ? `Click to exclude "${tag}"` :
        state === 'exclude' ? `Click to clear "${tag}"` :
        `Click to filter by "${tag}"`
      }
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        state === 'include' && 'border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
        state === 'exclude' && 'border-destructive/60 bg-destructive/10 text-destructive',
        state === 'unselected' && 'border-input bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground',
        className,
      )}
    >
      {color && state === 'unselected' && (
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      )}
      {state === 'include' && <span className="shrink-0 text-[10px] font-bold leading-none">+</span>}
      {state === 'exclude' && <span className="shrink-0 text-[10px] font-bold leading-none">−</span>}
      <span>{tag}</span>
      {count !== undefined && (
        <span className="ml-0.5 opacity-60">{count}</span>
      )}
    </button>
  );
}
