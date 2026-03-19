//File: apps/web/components/ui/ScrollArea.tsx

import * as React from "react"
import { cn } from '@/lib/utils';

type ScrollAreaProps = React.HTMLAttributes<HTMLDivElement>

const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn('relative overflow-auto vault-scrollbar', className)}
        {...props}
      >
        {children}
      </div>
    );
  }
);
ScrollArea.displayName = 'ScrollArea';

export { ScrollArea };
