import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import { Input } from "@/components/ui/Input";
import { TagChip } from "@/components/ui/TagChip";
import { normalizeTags, TagValidationError, emitTagsUpdated } from "@/lib/tags";

type TagEditorProps = {
  tags: string[];
  onSave: (tags: string[]) => Promise<void>;
  disabled?: boolean;
};

function splitInput(value: string): string[] {
  return value
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);
}

export function TagEditor({ tags, onSave, disabled }: TagEditorProps) {
  const [tagInput, setTagInput] = useState("");
  const [localTags, setLocalTags] = useState<string[]>(tags);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setLocalTags(tags);
  }, [tags]);

  const applyTags = async (nextTags: string[]) => {
    setIsSaving(true);
    try {
      await onSave(nextTags);
      setError(null);
      emitTagsUpdated();
    } catch (err) {
      if (err instanceof Error) setError(err.message);
      else setError("Unable to save tags.");
    } finally {
      setIsSaving(false);
    }
  };


  const commitInput = async () => {
    if (disabled || isSaving) return localTags;
    const pending = splitInput(tagInput);
    if (pending.length === 0) return localTags;
    const next = normalizeTags([...localTags, ...pending]);
    setLocalTags(next);
    setTagInput("");
    setError(null);
    await applyTags(next);
    return next;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === "," || event.key === "Tab") {
      event.preventDefault();
      try {
        void commitInput();
      } catch (err) {
        if (err instanceof TagValidationError) setError(err.message);
      }
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
          value={tagInput}
          onChange={e => setTagInput(e.target.value)}
          onBlur={() => {
            try {
              void commitInput();
            } catch (err) {
              if (err instanceof TagValidationError) setError(err.message);
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder="Add tags (comma-separated)"
          disabled={disabled || isSaving}
        />
      </div>

      {error && <div className="text-sm text-destructive">{error}</div>}
      {isSaving && <div className="text-xs text-muted-foreground">Saving...</div>}
    </div>
  );
}
