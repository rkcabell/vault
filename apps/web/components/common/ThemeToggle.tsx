//File: apps/web/components/common/ThemeToggle.tsx

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" className="relative">
        <div className="h-5 w-5" />
      </Button>
    );
  }

  const isDark = theme === 'dark';

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="relative overflow-hidden"
      aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
    >
      <div className="relative h-5 w-5">
      <Sun
        className={`absolute inset-0 h-5 w-5 transition-all duration-500 ${
          isDark
            ? 'rotate-180 scale-0 opacity-0 pointer-events-none'
            : 'rotate-0 scale-100 opacity-100'
        }`}
      />
      <Moon
        className={`absolute inset-0 h-5 w-5 transition-all duration-500 ${
          isDark
            ? 'rotate-0 scale-100 opacity-100'
            : 'rotate-180 scale-0 opacity-0 pointer-events-none'
        }`}
      />
      </div>
    </Button>
  );
}
