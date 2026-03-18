//File: apps/web/components/common/TopNav.tsx

import * as React from 'react';
import type { Route } from "next";
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, User, LogOut, ChevronDown, Settings, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/DropdownMenu';
import { useAuth } from '@/components/contexts/AuthContext';
import { useRemindersSummary } from '@/lib/reminders';
import { ThemeToggle } from './ThemeToggle';
import { HelpDialog } from './HelpDialog';

interface TopNavProps {
  onMenuClick?: () => void;
}

const navLinks = [
  { href: '/overview', label: 'Overview' },
  { href: '/library', label: 'Library' },
  { href: '/bundles', label: 'Bundles' },
  { href: '/reminders', label: 'Reminders' },
];

export function TopNav({ onMenuClick }: TopNavProps) {
  const pathname = usePathname();
  const { user, logout, status } = useAuth();
  const remindersSummary = useRemindersSummary();
  const overdueCount = remindersSummary.data?.overdue ?? 0;
  const [helpOpen, setHelpOpen] = React.useState(false);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return;
      if (e.key === '?') setHelpOpen((prev) => !prev);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const handleLogout = async () => {
    await logout();
  };

  const renderAuthControls = () => {
    if (status === 'loading') {
      return null;
    }

    if (status === 'authenticated') {
      const profile = user ?? { name: '', email: '', avatarUrl: null };
      const initial = (
        profile.name?.trim() ||
        profile.email?.trim() ||
        '?'
      ).charAt(0).toUpperCase();
      const avatarUrl = profile.avatarUrl?.trim() || null;

      const renderAvatar = (size: 'sm' | 'lg' = 'sm') => {
        const dimension = size === 'lg' ? 'h-10 w-10' : 'h-8 w-8';
        if (avatarUrl) {
          return (
            <img
              src={avatarUrl}
              alt={profile.name || profile.email || 'User avatar'}
              className={`${dimension} rounded-full object-cover border border-border`}
            />
          );
        }
        return (
          <div className={`flex ${dimension} items-center justify-center rounded-full bg-primary text-primary-foreground text-sm`}>
            {initial}
          </div>
        );
      };

      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="gap-2"
              aria-label="User menu"
            >
              {renderAvatar('sm')}
              <span className="hidden sm:inline-block text-sm font-medium">
                {profile.name || profile.email}
              </span>
              <ChevronDown className="h-4 w-4 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="flex items-center gap-2 p-2">
              {renderAvatar('lg')}
              <div className="flex flex-col">
                <span className="text-sm font-medium">{profile.name || 'User'}</span>
                <span className="text-xs text-muted-foreground">{profile.email}</span>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href={"/profile" as Route} className="cursor-pointer">
                <User className="mr-2 h-4 w-4" />
                Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={"/settings" as Route} className="cursor-pointer">
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleLogout}
              className="cursor-pointer text-destructive focus:text-destructive"
            >
              <LogOut className="mr-2 h-4 w-4" suppressHydrationWarning />
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }

    return (
      <Link href="/auth">
        <Button variant="default" size="sm">Sign In</Button>
      </Link>
    );
  };

  return (
    <nav className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-16 items-center gap-4 px-4 sm:px-6 lg:px-8">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={onMenuClick}
          aria-label="Toggle menu"
        >
          <Menu className="h-5 w-5" suppressHydrationWarning />
        </Button>

        <Link href={(status === 'authenticated' ? '/overview' : '/') as Route} className="flex items-center gap-2 font-semibold text-lg">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
             {"V"}
          </div>
          <span className="hidden sm:inline-block">Vault</span>
        </Link>

        <div className="hidden md:flex items-center gap-1 ml-6">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href as Route}
              className={cn(
                'relative px-3 py-2 text-sm font-medium rounded-md transition-colors',
                'hover:bg-accent hover:text-accent-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                pathname === link.href
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground'
              )}
            >
              {link.label}
              {link.href === '/reminders' && overdueCount > 0 && (
                <span className="nav-overdue-badge">{overdueCount}</span>
              )}
            </Link>
          ))}
        </div>

        <div className="flex-1" />

        <Button
          variant="ghost"
          size="icon"
          onClick={() => setHelpOpen(true)}
          aria-label="Help"
        >
          <HelpCircle className="h-5 w-5" />
        </Button>

        <ThemeToggle />

        {renderAuthControls()}
      </div>

      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </nav>
  );
}
