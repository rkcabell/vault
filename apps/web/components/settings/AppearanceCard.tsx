"use client";

import { usePreferences, type LightTheme, type DarkTheme } from "@/hooks/usePreferences";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";

type LightThemeOption = { id: LightTheme; label: string; bg: string; card: string; borderColor: string; textColor: string };
type DarkThemeOption  = { id: DarkTheme;  label: string; bg: string; card: string; borderColor: string; textColor: string };

const LIGHT_THEMES: LightThemeOption[] = [
  { id: "default",      label: "Default",      bg: "hsl(240,5%,93%)",   card: "hsl(240,5%,99%)",   borderColor: "hsl(240,5.9%,90%)",  textColor: "hsl(0,0%,3.9%)"   },
  { id: "latte",        label: "Latte",        bg: "hsl(36,38%,86%)",   card: "hsl(36,60%,95%)",   borderColor: "hsl(36,24%,80%)",    textColor: "hsl(0,0%,3.9%)"   },
  { id: "sandstone",    label: "Sandstone",    bg: "hsl(28,50%,76%)",   card: "hsl(28,55%,82%)",   borderColor: "hsl(28,36%,67%)",    textColor: "hsl(0,0%,3.9%)"   },
  { id: "mist",         label: "Mist",         bg: "hsl(202,22%,87%)",  card: "hsl(202,28%,94%)",  borderColor: "hsl(202,16%,83%)",   textColor: "hsl(0,0%,3.9%)"   },
  { id: "lavender",     label: "Lavender",     bg: "hsl(263,22%,87%)",  card: "hsl(263,28%,94%)",  borderColor: "hsl(263,16%,83%)",   textColor: "hsl(0,0%,3.9%)"   },
  { id: "dream",        label: "Dream",        bg: "hsl(335,28%,88%)",  card: "hsl(335,34%,95%)",  borderColor: "hsl(335,18%,84%)",   textColor: "hsl(0,0%,3.9%)"   },
  { id: "cotton-candy", label: "Cotton Candy", bg: "hsl(335,55%,82%)",  card: "hsl(200,72%,88%)",  borderColor: "hsl(330,100%,60%)",  textColor: "hsl(0,0%,3.9%)"   },
  { id: "mint",         label: "Mint",         bg: "hsl(148,20%,83%)",  card: "hsl(145,26%,92%)",  borderColor: "hsl(148,16%,77%)",   textColor: "hsl(0,0%,3.9%)"   },
  { id: "garden",       label: "Garden",       bg: "hsl(130,26%,55%)",  card: "hsl(137,32%,72%)",  borderColor: "hsl(130,26%,46%)",   textColor: "hsl(0,0%,3.9%)"   },
];

const DARK_THEMES: DarkThemeOption[] = [
  { id: "new-moon",  label: "New Moon",  bg: "hsl(220,28%,6%)",   card: "hsl(221,39%,11%)",  borderColor: "hsl(215,20%,18%)",  textColor: "hsl(0,0%,98%)"    },
  { id: "charcoal",  label: "Charcoal",  bg: "hsl(220,5%,13%)",   card: "hsl(220,5%,20%)",   borderColor: "hsl(220,5%,26%)",   textColor: "hsl(0,0%,88%)"    },
  { id: "matrix",    label: "Matrix",    bg: "hsl(0,0%,2%)",      card: "hsl(120,8%,7%)",    borderColor: "hsl(120,10%,14%)",  textColor: "hsl(120,80%,60%)" },
  { id: "solarized", label: "Solarized", bg: "hsl(193,100%,11%)", card: "hsl(192,81%,14%)",  borderColor: "hsl(192,50%,22%)",  textColor: "hsl(180,7%,63%)"  },
];

function ThemeSwatch<T extends string>({
  theme,
  selected,
  onSelect,
}: {
  theme: { id: T; label: string; bg: string; card: string; borderColor: string; textColor: string };
  selected: boolean;
  onSelect: (id: T) => void;
}) {
  return (
    <button
      onClick={() => onSelect(theme.id)}
      className={`flex flex-col items-center gap-1.5 rounded-lg p-2 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "ring-2 ring-primary" : ""}`}
      aria-pressed={selected}
    >
      <div
        className="h-10 w-16 rounded-md border flex items-center justify-center"
        style={{ backgroundColor: theme.bg, borderColor: theme.borderColor }}
      >
        <div
          className="h-5 w-8 rounded shadow-sm border"
          style={{ backgroundColor: theme.card, borderColor: theme.textColor }}
        />
      </div>
      <span className="text-[11px] font-medium text-muted-foreground leading-none">
        {theme.label}
      </span>
    </button>
  );
}

export function AppearanceCard() {
  const { prefs, updatePreferences, isLoaded } = usePreferences();

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Color schemes for light and dark mode.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Light</p>
          <div className={`flex flex-wrap gap-1 transition-opacity ${!isLoaded ? "opacity-50 pointer-events-none" : ""}`}>
            {LIGHT_THEMES.map(t => (
              <ThemeSwatch
                key={t.id}
                theme={t}
                selected={prefs.lightTheme === t.id}
                onSelect={(id) => updatePreferences({ lightTheme: id })}
              />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dark</p>
          <div className={`flex flex-wrap gap-1 transition-opacity ${!isLoaded ? "opacity-50 pointer-events-none" : ""}`}>
            {DARK_THEMES.map(t => (
              <ThemeSwatch
                key={t.id}
                theme={t}
                selected={prefs.darkTheme === t.id}
                onSelect={(id) => updatePreferences({ darkTheme: id })}
              />
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
