import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Input } from "@/components/ui/Input";
import { TagChip } from "@/components/ui/TagChip";
import { normalizeTags, TagValidationError, emitTagsUpdated } from "@/lib/tags";

type TagEditorProps = {
  tags: string[];
  onSave: (tags: string[], signal: AbortSignal) => Promise<void>;
  disabled?: boolean;
};

function splitInput(value: string): string[] {
  return value
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);
}

export function TagEditor({ tags, onSave, disabled }: TagEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [localTags, setLocalTags] = useState<string[]>(tags);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setLocalTags(tags);
  }, [tags]);

  const applyTags = async (nextTags: string[]) => {
    // Cancel any in-flight save so the latest state always wins.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsSaving(true);
    try {
      await onSave(nextTags, controller.signal);
      if (controller.signal.aborted) return;
      setError(null);
      emitTagsUpdated();
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof Error) setError(err.message);
      else setError("Unable to save tags.");
    } finally {
      if (!controller.signal.aborted) setIsSaving(false);
    }
  };


  const commitInput = async () => {
    if (disabled || isSaving) return localTags;
    const pending = splitInput(tagInput);
    if (pending.length === 0) return localTags;
    let next: string[];
    try {
      const normalizedPending = normalizeTags(pending);
      const duplicates = normalizedPending.filter(t => localTags.includes(t));
      if (duplicates.length > 0) {
        setError(`Tag already added: ${duplicates.join(", ")}`);
        return localTags;
      }
      next = normalizeTags([...localTags, ...normalizedPending]);
    } catch (err) {
      if (err instanceof TagValidationError) setError(err.message);
      return localTags;
    }
    setLocalTags(next);
    setTagInput("");
    setError(null);
    await applyTags(next);
    inputRef.current?.focus();
    return next;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === "," || event.key === "Tab") {
      event.preventDefault();
      void commitInput();
    }
  };

  const removeTag = async (tag: string) => {
    if (disabled || isSaving) return;
    const next = localTags.filter(t => t !== tag);
    setLocalTags(next);
    setError(null);
    await applyTags(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {localTags.length === 0 && <span className="text-sm text-muted-foreground">No tags yet</span>}
        {localTags.map(tag => (
          <TagChip key={tag} onRemove={() => void removeTag(tag)} onClick={() => void removeTag(tag)}>
            {tag}
          </TagChip>
        ))}
      </div>

      <div className="flex gap-2">
        <Input
          ref={inputRef}
          value={tagInput}
          onChange={e => setTagInput(e.target.value)}
          onBlur={() => { void commitInput(); }}
          onKeyDown={handleKeyDown}
          placeholder="Add tags (comma-separated)"
          disabled={disabled}
        />
      </div>

      {error && <div className="text-sm text-destructive">{error}</div>}
      {isSaving && <div className="text-xs text-muted-foreground">Saving...</div>}
    </div>
  );
}
