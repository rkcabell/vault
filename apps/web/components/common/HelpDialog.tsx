'use client';

import * as React from 'react';
import * as ReactDOM from 'react-dom';
import {
  LayoutDashboard,
  Library,
  Layers,
  Bell,
  Upload,
  Tag,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/Button';

type Tab = 'features' | 'shortcuts' | 'about';

const features = [
  { icon: LayoutDashboard, name: 'Overview',   description: 'Recent uploads, quick stats, and at-a-glance activity.' },
  { icon: Library,         name: 'Library',    description: 'Browse and filter all your media by tag, type, or search.' },
  { icon: Layers,          name: 'Bundles',    description: 'Curated collections — group related media together.' },
  { icon: Bell,            name: 'Reminders',  description: 'Set time-based reminders on any media item.' },
  { icon: Upload,          name: 'Upload',     description: 'Drag-and-drop or pick files. Supports images, PDFs, and more.' },
  { icon: Tag,             name: 'Tags',       description: 'Apply tags in the Library and filter via the sidebar.' },
];

const shortcuts = [
  { keys: ['Esc'], action: 'Close any open dialog or modal' },
  { keys: ['?'],   action: 'Open this help panel' },
];

interface HelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HelpDialog({ open, onOpenChange }: HelpDialogProps) {
  const [activeTab, setActiveTab] = React.useState<Tab>('features');

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const panel = document.getElementById('help-panel');
      if (panel && !panel.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onOpenChange]);

  if (!open) return null;

  return ReactDOM.createPortal(
    <div
      id="help-panel"
      className={cn(
        'fixed top-16 right-4 z-50 w-80',
        'rounded-lg border bg-background shadow-lg',
        'flex flex-col',
      )}
    >
      {/* Fixed header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0">
        <span className="text-sm font-semibold">Help</span>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onOpenChange(false)}
          aria-label="Close help"
          className="-mr-1 h-7 w-7"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Fixed tab bar */}
      <div className="flex gap-0 border-b px-4 shrink-0">
        {(['features', 'shortcuts', 'about'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'px-2.5 py-1.5 text-xs font-medium capitalize transition-colors',
              'hover:text-foreground focus-visible:outline-none',
              activeTab === tab
                ? 'text-foreground border-b-2 border-primary -mb-px'
                : 'text-muted-foreground'
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Scrollable content */}
      <div className="overflow-y-auto p-4 max-h-[60vh]">

        {activeTab === 'features' && (
          <div className="grid grid-cols-1 gap-3">
            {features.map(({ icon: Icon, name, description }) => (
              <div key={name} className="flex items-start gap-3">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
                  <Icon className="h-3.5 w-3.5" />
                </div>
                <div>
                  <p className="text-xs font-medium leading-none mb-0.5">{name}</p>
                  <p className="text-xs text-muted-foreground leading-snug">{description}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'shortcuts' && (
          <div className="space-y-1">
            {shortcuts.map(({ keys, action }) => (
              <div key={action} className="flex items-center justify-between py-2 border-b last:border-0">
                <span className="text-xs text-muted-foreground">{action}</span>
                <div className="flex gap-1 ml-3 shrink-0">
                  {keys.map((key) => (
                    <kbd
                      key={key}
                      className="inline-flex items-center rounded border bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground"
                    >
                      {key}
                    </kbd>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'about' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-semibold">
                V
              </div>
              <div>
                <p className="text-xs font-semibold">Vault</p>
                <p className="text-xs text-muted-foreground">v0.1</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Personal media and document management. Upload files, organize with tags and bundles, and set reminders to revisit them later.
            </p>
            <p className="text-xs text-muted-foreground">
              Contribute at{' '}
              <a
                href="https://github.com/rkcabell/vault"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-foreground transition-colors"
              >
                github.com/rkcabell/vault
              </a>
            </p>
          </div>
        )}

      </div>
    </div>,
    document.body
  );
}
