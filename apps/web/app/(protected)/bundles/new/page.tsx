"use client";

import { useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Route } from 'next';
import { ArrowLeft, FolderOpen, Loader2 } from 'lucide-react';
import { emitBundlesUpdated } from '@/lib/bundles';
import { BUNDLE_ICONS, DEFAULT_BUNDLE_COVER_ID } from '@/lib/bundleIcons';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';

export default function NewBundlePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [coverMediaId, setCoverMediaId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await apiFetch('/api/bundles', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, description: description.trim() || undefined, coverMediaId: coverMediaId ?? undefined }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setError(text || `Error ${res.status}`);
        return;
      }

      const data = (await res.json()) as { bundle: { id: string } };
      emitBundlesUpdated();
      router.push(`/bundles/${data.bundle.id}` as Route);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-6 max-w-xl mx-auto">
      <div className="mb-6">
        <Link
          href={'/bundles' as Route}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Bundles
        </Link>
      </div>

      <h1 className="text-2xl font-bold tracking-tight mb-6">New Bundle</h1>

      <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="My Bundle"
            maxLength={200}
            disabled={isSubmitting}
            autoFocus
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <textarea
            id="description"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="What's in this bundle?"
            maxLength={1000}
            disabled={isSubmitting}
            rows={3}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none"
          />
        </div>

        <div className="space-y-2">
          <Label>Icon <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setCoverMediaId(DEFAULT_BUNDLE_COVER_ID)}
              title="Default (no icon)"
              className={cn(
                'h-10 w-10 rounded-md border-2 flex items-center justify-center bg-muted transition-colors',
                coverMediaId === null || coverMediaId === DEFAULT_BUNDLE_COVER_ID
                  ? 'border-primary'
                  : 'border-transparent hover:border-muted-foreground/40',
              )}
            >
              <FolderOpen className="h-5 w-5 text-muted-foreground/60" />
            </button>
            {BUNDLE_ICONS.map(({ key, label, Icon }) => {
              const value = `icon:${key}`;
              const selected = coverMediaId === value;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCoverMediaId(value)}
                  title={label}
                  className={cn(
                    'h-10 w-10 rounded-md border-2 flex items-center justify-center bg-muted transition-colors',
                    selected
                      ? 'border-primary'
                      : 'border-transparent hover:border-muted-foreground/40',
                  )}
                >
                  <Icon className={cn('h-5 w-5', selected ? 'text-foreground' : 'text-muted-foreground/60')} />
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        <div className="flex items-center gap-3 pt-1">
          <Button type="submit" disabled={isSubmitting || !name.trim()}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create Bundle
          </Button>
          <Link
            href={'/bundles' as Route}
            className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors h-10 px-4 py-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
