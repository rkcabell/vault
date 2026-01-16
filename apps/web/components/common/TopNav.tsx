//File: apps/web/components/common/TopNav.tsx

import { useState } from 'react';
import type { Route } from "next";
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Search, Menu, User, LogOut, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/DropdownMenu';
import { Input } from '@/ui/Input';
import { useAuth } from '@/components/contexts/AuthContext';
import { ThemeToggle } from './ThemeToggle';

interface TopNavProps {
  onMenuClick?: () => void;
}

const navLinks = [
  { href: '/search', label: 'Search' },
  { href: '/saved-views', label: 'Saved Views' },
  { href: '/albums', label: 'Albums' },
  { href: '/entities', label: 'Entities' },
  { href: '/reminders', label: 'Reminders' },
];

export function TopNav({ onMenuClick }: TopNavProps) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const handleLogout = async () => {
    await logout();
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      window.location.href = `/search?q=${encodeURIComponent(searchQuery)}`;
    }
  };

  const initial =
  (user?.name?.trim()?.charAt(0) ||
    user?.email?.trim()?.charAt(0) ||
    "?").toUpperCase();

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
          <Menu className="h-5 w-5" />
        </Button>

        <Link href="/" className="flex items-center gap-2 font-semibold text-lg">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
             {"U"}
          </div>
          <span className="hidden sm:inline-block">Vault</span>
        </Link>

        <div className="hidden md:flex items-center gap-1 ml-6">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href as Route}
              className={cn(
                'px-3 py-2 text-sm font-medium rounded-md transition-colors',
                'hover:bg-accent hover:text-accent-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                pathname === link.href
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground'
              )}
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="flex-1" />

        {searchExpanded ? (
          <form onSubmit={handleSearch} className="flex items-center gap-2 flex-1 max-w-md">
            <Input
              type="search"
              placeholder="Search media..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onBlur={() => {
                if (!searchQuery) setSearchExpanded(false);
              }}
              autoFocus
              className="h-9"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearchQuery('');
                setSearchExpanded(false);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSearchExpanded(true)}
            aria-label="Search"
            className="hidden sm:flex"
          >
            <Search className="h-5 w-5" />
          </Button>
        )}

        <ThemeToggle />

        {user ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="gap-2"
                aria-label="User menu"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm">
                 {initial}
                </div>
                <span className="hidden sm:inline-block text-sm font-medium">
                  {user.name || user.email}
                </span>
                <ChevronDown className="h-4 w-4 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <div className="flex items-center gap-2 p-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  {initial}
                </div>
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{user.name || 'User'}</span>
                  <span className="text-xs text-muted-foreground">{user.email}</span>
                </div>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href={"/profile" as Route} className="cursor-pointer">
                  <User className="mr-2 h-4 w-4" />
                  Profile
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleLogout}
                className="cursor-pointer text-destructive focus:text-destructive"
              >
                <LogOut className="mr-2 h-4 w-4" />
                Logout
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Link href="/auth">
            <Button variant="default" size="sm">Sign In</Button>
          </Link>
        )}
      </div>
    </nav>
  );
}
