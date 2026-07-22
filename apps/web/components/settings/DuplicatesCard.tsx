import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { CopyCheck } from "lucide-react";

/** Entry point to the duplicate-review page (exact byte-identical copies). */
export function DuplicatesCard () {
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle>Duplicates</CardTitle>
        <CardDescription className="mt-1">
          Find byte-identical copies of the same file across uploads and indexed
          folders, then pick which copy to keep. Originals on disk are never
          deleted.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-6 pb-6 pt-0">
        <Button asChild variant="outline" size="sm" className="gap-1.5">
          <Link href="/duplicates">
            <CopyCheck className="h-4 w-4" />
            Review duplicates
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
