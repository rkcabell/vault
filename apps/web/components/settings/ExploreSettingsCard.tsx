"use client";

import { usePreferences } from "@/hooks/usePreferences";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { BUCKET_ORDER, BUCKET_LABEL, FALLBACK_BASE, type BucketKey } from "@/components/overview/viz/vizUtils";

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)))
      .toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const DEFAULT_HEX: Record<BucketKey, string> = Object.fromEntries(
  BUCKET_ORDER.map(b => [b, hslToHex(...FALLBACK_BASE[b])])
) as Record<BucketKey, string>;

export function ExploreSettingsCard() {
  const { prefs, updatePreferences, isLoaded } = usePreferences();
  const colors = prefs.exploreBucketColors ?? {};

  const setColor = (bucket: BucketKey, hex: string) => {
    updatePreferences({ exploreBucketColors: { ...colors, [bucket]: hex } });
  };

  const resetAll = () => {
    updatePreferences({ exploreBucketColors: {} });
  };

  const hasCustom = Object.keys(colors).length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Explore Colors</CardTitle>
        <CardDescription>Base color for each file type bucket in the Explore view.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className={`grid grid-cols-2 gap-x-8 gap-y-1 transition-opacity ${!isLoaded ? "opacity-50 pointer-events-none" : ""}`}>
          {BUCKET_ORDER.map(bucket => {
            const current = colors[bucket] ?? DEFAULT_HEX[bucket];
            return (
              <div key={bucket} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                <span className="text-sm font-medium">{BUCKET_LABEL[bucket]}</span>
                <label className="relative cursor-pointer">
                  <div
                    className="h-7 w-7 rounded border border-border shadow-sm"
                    style={{ backgroundColor: current }}
                  />
                  <input
                    type="color"
                    value={current}
                    onChange={e => setColor(bucket, e.target.value)}
                    className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                  />
                </label>
              </div>
            );
          })}
        </div>
        {hasCustom && (
          <div className="flex justify-end mt-4">
            <Button variant="outline" size="sm" onClick={resetAll}>
              Reset to defaults
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
