import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import type { MouseEvent } from "react";
import { cn } from "@/lib/utils";

const tagChipVariants = cva(
  "group inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary/10 text-primary hover:bg-primary/20",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        outline: "text-foreground",
        // Origin-aware tones: user-made tags read slightly bolder than the
        // default; auto tags are muted so user tags take visual priority.
        user: "border-transparent bg-primary/20 text-primary hover:bg-primary/30",
        auto: "border-transparent bg-muted text-muted-foreground hover:bg-muted/70",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface TagChipProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof tagChipVariants> {
  onRemove?: () => void;
}

export function TagChip({
  className,
  variant,
  children,
  onRemove,
  onClick,
  ...props
}: TagChipProps) {
  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onRemove?.();
  };

  return (
    <div
      className={cn(
        tagChipVariants({ variant }),
        onRemove && "group relative pr-2 transition-[padding] duration-200 delay-100 hover:pr-6 hover:delay-0",
        className,
      )}
      onClick={onClick}
      {...props}
    >
      <span className="truncate">{children}</span>
      {onRemove && (
        <button
          type="button"
          onClick={handleRemove}
          className="absolute right-1 flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground opacity-0 duration-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 group-hover:opacity-100 group-hover:duration-75"
          aria-label="Remove tag"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export { tagChipVariants };
