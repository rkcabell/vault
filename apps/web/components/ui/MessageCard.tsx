import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";

interface MessageCardProps {
  heading: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
  actionVariant?: "default" | "outline";
}

export function MessageCard({ heading, body, actionLabel, onAction, actionVariant = "default" }: MessageCardProps) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="text-lg font-semibold">{heading}</div>
        <p className="max-w-md text-sm text-muted-foreground">{body}</p>
        {actionLabel && onAction && (
          <Button variant={actionVariant} onClick={onAction}>
            {actionLabel}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
