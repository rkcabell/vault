//File: apps/web/components/common/PageHeader.tsx
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
  titleClassName?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  className,
  titleClassName,
}: PageHeaderProps) {
  return (
    <div className={cn('mb-8 flex items-center justify-between', className)}>
      <div className="min-w-0">
        <h1 className={cn("text-3xl font-bold tracking-tight", titleClassName)}>
          {title}
        </h1>
        {description && (
          <p className="mt-2 text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
