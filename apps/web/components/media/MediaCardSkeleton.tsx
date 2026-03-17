import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/ui/Card';
import { Skeleton } from "@/ui/Skeleton";

interface MediaCardSkeletonProps {
  variant?: 'grid' | 'list';
  className?: string;
  density?: "comfortable" | "compact";
}

export function MediaCardSkeleton({
  variant = 'grid',
  className,
  density = "comfortable",
}: MediaCardSkeletonProps) {
  if (variant === 'list') {
    const isCompact = density === "compact";
    return (
      <Card className={cn('', className)}>
        <CardContent className={cn("p-4", isCompact && "px-2 py-1")}>
          <div className={cn("flex items-center gap-4", isCompact && "gap-2")}>
            <Skeleton className={cn("h-16 w-24 flex-shrink-0 rounded-md", isCompact && "h-12 w-20")} />

            <div className={cn("flex-1 space-y-2", isCompact && "space-y-1.5")}>
              <Skeleton className={cn("h-5 w-3/4", isCompact && "h-4")} />
              <div className="flex gap-1">
                <Skeleton className={cn("h-5 w-16", isCompact && "h-4")} />
                <Skeleton className={cn("h-5 w-16", isCompact && "h-4")} />
                <Skeleton className={cn("h-5 w-16", isCompact && "h-4")} />
              </div>
            </div>

            <div className={cn("flex items-center gap-2", isCompact && "gap-1")}>
              <Skeleton className={cn("h-6 w-16", isCompact && "h-5")} />
              <Skeleton className={cn("h-9 w-9", isCompact && "h-8 w-8")} />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn('flex h-full flex-col overflow-hidden', className)}>
      <Skeleton className="aspect-[4/3] w-full flex-shrink-0" />
      <CardContent className="flex flex-1 flex-col p-4">
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="space-y-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
          </div>
          <div className="flex gap-1 pt-1">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-16" />
          </div>
        </div>
        <div className="mt-auto flex items-center gap-2 pt-2">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-9 ml-auto" />
        </div>
      </CardContent>
    </Card>
  );
}
