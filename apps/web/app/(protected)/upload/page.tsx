"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";

import { Container } from "@/components/common/Container";
import { PageHeader } from "@/components/common/PageHeader";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DirectoryPicker } from "@/components/settings/DirectoryPicker";
import { IndexRootAdder } from "@/components/settings/IndexRootAdder";
import { ReconcileCheck } from "@/components/settings/ReconcileCheck";

import { useUpload } from "@/components/contexts/UploadContext";
import { useIndexProgress } from "@/components/contexts/IndexProgressContext";
import { usePreferences } from "@/hooks/usePreferences";
import { toast } from "@/components/ui/Toaster";
import { emitTagsUpdated } from "@/lib/tags";
import { getFileSizeError, UPLOAD_LIMIT_LABELS } from "@/lib/media/ingestLimits";
import { isFileDrag, readDroppedFiles, MAX_DROPPED_FILES } from "@/lib/media/dropEntries";
import { formatBytes } from "@/lib/media/utils";
import { getIndexRoots } from "@/lib/media/indexing";
import {
  getIngestConfig, setIngestFolder, ingestFile, unpackNew,
  getPendingFiles, notifyUploadStart, notifyUploadSuccess, notifyUploadFailures,
  uploadBatch, applyFailures, exitToLibrary,
  type IngestConfig, type UploadPlan, type FailedUpload, type CompletedUpload,
} from "@/lib/media/ingest";

import {
  Upload,
  X,
  Image as ImageIcon,
  Video,
  FileText,
  ArrowLeft,
  CheckCircle2,
  AlertCircle,
  FolderOpen,
  FolderSearch,
  FolderInput,
} from "lucide-react";

const getFileIcon = (type: string) => {
  if (type.startsWith("image/")) return ImageIcon;
  if (type.startsWith("video/")) return Video;
  return FileText;
};

const LIBRARY_PATH = "/library";

export default function AddFilesPage() {
  const router = useRouter();
  const { files, addFiles, removeFile, clearFiles, updateFileStatus } =
    useUpload();
  const { prefs } = usePreferences();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const [isUploading, setIsUploading] = useState(false);

  const [indexRoots, setIndexRoots] = useState<string[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [indexPath, setIndexPath] = useState<string | null>(null);
  const [recursive, setRecursive] = useState(true);
  const [isStarting, setIsStarting] = useState(false);

  const [ingest, setIngest] = useState<IngestConfig | null>(null);
  const canSend = ingest?.enabled === true;
  const [showIngestPicker, setShowIngestPicker] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [savingIngestFolder, setSavingIngestFolder] = useState(false);

  // Scan progress is tracked globally so it survives navigation/reload; completion
  // toasts + sidebar refreshes are handled by the provider.
  const { status: indexStatus, start: startIndexScan, stop: stopIndexScan } = useIndexProgress();
  const isIndexing = isStarting || (!!indexStatus && !indexStatus.done && indexStatus.state !== "failed");
  const indexEnabled = indexRoots.length > 0;

  const refreshIngest = useCallback(async () => {
    try {
      setIngest(await getIngestConfig());
    } catch {
      setIngest(null);
    }
  }, []);

  useEffect(() => {
    void getIndexRoots().then(r => setIndexRoots(r.roots));
    void refreshIngest();
  }, [refreshIngest]);

  const handleStartIndex = async () => {
    if (!indexPath || isIndexing) return;
    setIsStarting(true);
    try {
      await startIndexScan(indexPath, recursive);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Indexing failed.", { variant: "error" });
    } finally {
      setIsStarting(false);
    }
  };

  const handleChooseIngestFolder = async (folderPath: string) => {
    setShowIngestPicker(false);
    setSavingIngestFolder(true);
    setIngestError(null);
    try {
      const result = await setIngestFolder(indexRoots, folderPath);
      if (!result.ok) setIngestError(result.message ?? "Could not save the folder.");
      await refreshIngest();
    } catch (err) {
      setIngestError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSavingIngestFolder(false);
    }
  };

  const completedCount = useMemo(
    () => files.filter((f) => f.status === "completed").length,
    [files],
  );
  const totalCount = files.length;

  const handleFileSelect = (selectedFiles: FileList | File[] | null) => {
    if (!selectedFiles || selectedFiles.length === 0) return;
    const incoming = Array.from(selectedFiles);
    const valid: File[] = [];
    const tooLarge: File[] = [];
    const errors: string[] = [];

    incoming.forEach((file) => {
      const error = getFileSizeError(file);
      if (error) {
        errors.push(`${file.name}: ${error}`);
        tooLarge.push(file);
        return;
      }
      valid.push(file);
    });

    if (errors.length > 0) {
      const summary =
        errors.length === 1
          ? errors[0]
          : `${errors.length} files exceed the size limits. First: ${errors[0]}`;
      toast(summary, { variant: "error", duration: 5000 });
    }

    if (valid.length > 0) {
      addFiles(valid);
    }

    if (tooLarge.length > 0) {
      addFiles(tooLarge, { status: "error", error: "File Too Large" });
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    if (!canSend) {
      toast("Choose a folder for sent files first.", { variant: "error" });
      return;
    }
    void readDroppedFiles(e.dataTransfer).then(({ files: dropped, truncated }) => {
      if (truncated) {
        toast(`That drop was too large — the first ${MAX_DROPPED_FILES} files were added.`, {
          variant: "error",
          duration: 5000,
        });
      }
      handleFileSelect(dropped);
    });
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isFileDrag(e.dataTransfer)) return;
    dragDepthRef.current += 1;
    setIsDragging(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isFileDrag(e.dataTransfer)) return;
    e.dataTransfer.dropEffect = "copy";
    setIsDragging(true);
  };

  // Depth-counted: dragleave also fires when the cursor crosses onto a child,
  // and clearing on that flickers the highlight over the inner buttons.
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isFileDrag(e.dataTransfer)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  };

  const sendOne = async (plan: UploadPlan) => {
    updateFileStatus(plan.fileId, "uploading");
    const media = await ingestFile(plan.file);
    updateFileStatus(plan.fileId, "completed");
    return media;
  };

  const handleUpload = async () => {
    const pending = getPendingFiles(files);
    if (pending.length === 0) return;

    setIsUploading(true);
    notifyUploadStart(pending.length);

    const preErrorCount = files.filter(f => f.status === "error").length;

    try {
      const plans: UploadPlan[] = pending.map(p => ({ fileId: p.id, file: p.file }));
      const { failed, completed } = await uploadBatch(plans, sendOne);
      applyFailures(failed as FailedUpload[], (id, _status, error) =>
        updateFileStatus(id, "error", error),
      );

      if (completed.length > 0) {
        // Best-effort: the rows exist and are indexed either way, so a failure
        // here costs the archive expansion, not the files.
        await unpackNew(completed.map(c => c.media.id), prefs.autoUnpackArchives).catch(() => {});
      }

      const totalFailed = failed.length + preErrorCount;
      if (totalFailed === 0) {
        emitTagsUpdated();
        notifyUploadSuccess(completed.filter(c => c.media.renamed).length);
        exitToLibrary(clearFiles, () => router.push(`${LIBRARY_PATH}?uploaded=1`));
        return;
      }

      for (const item of completed as CompletedUpload[]) removeFile(item.fileId);
      if (failed.length < pending.length) emitTagsUpdated();
      notifyUploadFailures(totalFailed);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Send failed.";
      for (const p of pending) updateFileStatus(p.id, "error", message);
      notifyUploadFailures(pending.length);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Container className="py-6">
      <PageHeader
        title="Add files"
        description="Index folders where your files already live, or send files to Vault from this device."
        actions={
          <Button variant="outline" size="sm" onClick={() => router.push(LIBRARY_PATH)}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Library
          </Button>
        }
      />

      <div className="space-y-6">
        <Card className="border-primary/40 p-6 shadow-md">
          <div className="mb-4 flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <FolderSearch className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold">Index a folder</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Vault reads a folder you already own and builds thumbnails and text search for
                what is in it. Nothing is copied and the folder is never modified, so one copy of
                each file ever exists.
              </p>
            </div>
          </div>

          {!indexEnabled ? (
            <div className="rounded-md border border-dashed border-border p-4">
              <p className="text-sm">No folders are allowed for indexing yet.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Pick one to get started — you can add more, and set exclusions, in{" "}
                <Link href={"/settings" as Route} className="underline underline-offset-2 hover:text-foreground">
                  Settings → In-place indexing
                </Link>
                .
              </p>
              <div className="mt-3">
                <IndexRootAdder
                  roots={indexRoots}
                  onAdded={next => { setIndexRoots(next); setIndexPath(next[next.length - 1] ?? null); }}
                  label="Choose a folder…"
                />
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Allowed folders — click to select
                </p>
                {indexRoots.map(root => (
                  <button
                    key={root}
                    onClick={() => setIndexPath(root)}
                    disabled={isIndexing}
                    className={`block w-full rounded border px-3 py-1.5 text-left font-mono text-sm transition-colors hover:bg-accent disabled:pointer-events-none ${
                      indexPath === root ? "border-primary bg-primary/10" : "border-border"
                    }`}
                  >
                    {root}
                  </button>
                ))}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <IndexRootAdder
                  roots={indexRoots}
                  onAdded={setIndexRoots}
                  disabled={isIndexing}
                />
                <Button variant="outline" size="sm" onClick={() => setShowPicker(true)} disabled={isIndexing}>
                  {indexPath ? "Change subfolder…" : "Choose subfolder…"}
                </Button>
                <Link
                  href={"/settings" as Route}
                  className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Manage folders and exclusions
                </Link>
              </div>

              {indexPath && !indexRoots.includes(indexPath) && (
                <p className="mt-2 break-all font-mono text-sm">{indexPath}</p>
              )}

              {indexPath && (
                <>
                  <label className="mt-4 flex w-fit items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={recursive}
                      onChange={e => setRecursive(e.target.checked)}
                      disabled={isIndexing}
                    />
                    Include subfolders
                  </label>

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button onClick={handleStartIndex} disabled={isIndexing}>
                      {isIndexing ? "Scanning…" : "Scan now"}
                    </Button>
                    {isIndexing && (
                      <Button variant="outline" onClick={() => void stopIndexScan()}>
                        Cancel scan
                      </Button>
                    )}
                    {indexStatus && (
                      <span
                        className={`text-sm ${
                          indexStatus.state === "failed" ? "text-destructive" : "text-muted-foreground"
                        }`}
                      >
                        Scanned {indexStatus.scanned} · indexed {indexStatus.indexed} · filtered{" "}
                        {indexStatus.filtered}
                        {indexStatus.state === "failed"
                          ? " · failed"
                          : indexStatus.aborted
                            ? " · aborted"
                            : indexStatus.done
                              ? " · done"
                              : "…"}
                      </span>
                    )}
                  </div>
                </>
              )}

              <div className="mt-5 border-t border-border pt-4">
                <ReconcileCheck enabled={!isIndexing} />
              </div>
            </>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="text-lg font-semibold">Send files to Vault</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            For files that are not already on a disk Vault can reach — a phone, another laptop, a
            download. They are saved into a folder you choose and indexed like everything else, so
            a rescan can always find them again. Indexing is still the better route for files that
            are already on a disk you control: nothing has to be sent at all.
          </p>

          {canSend ? (
            <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
              <span className="text-muted-foreground">Files are saved to</span>
              <span className="break-all font-mono">{ingest?.folderPath}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2"
                onClick={() => setShowIngestPicker(true)}
                disabled={isUploading || savingIngestFolder}
              >
                Change…
              </Button>
            </div>
          ) : (
            <div className="mt-4 rounded-md border border-dashed border-border p-4">
              <p className="text-sm">
                {ingest?.message ?? "Sending files is not set up yet."}
              </p>
              {ingest?.reason === "no-roots" ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  Sent files are saved into one of your own folders, so Vault needs an allowed
                  folder first. Add one above.
                </p>
              ) : (
                <>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Pick a folder inside one of your indexed folders. Everything you send lands
                    there as an ordinary file.
                  </p>
                  <div className="mt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setShowIngestPicker(true)}
                      disabled={savingIngestFolder || indexRoots.length === 0}
                    >
                      <FolderInput className="h-4 w-4" />
                      {savingIngestFolder ? "Saving…" : "Choose folder…"}
                    </Button>
                  </div>
                </>
              )}
              {ingestError && (
                <p className="mt-2 break-all text-sm text-destructive" role="status">{ingestError}</p>
              )}
            </div>
          )}

          <div
            className={`mt-4 rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
              isDragging ? "border-primary bg-primary/5" : "border-border"
            } ${canSend ? "" : "opacity-50"}`}
            onDrop={handleDrop}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <Upload className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
            <h3 className="mb-1 font-medium">Drop files here or pick them below</h3>
            <p className="mb-4 text-xs text-muted-foreground">
              Images, videos, and documents · {UPLOAD_LIMIT_LABELS.other} max per file
            </p>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleFileSelect(e.target.files)}
            />
            {/* webkitdirectory makes the OS dialog pick a folder, which the browser
                expands recursively. Not in React's input types, hence the spread. */}
            <input
              ref={folderInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleFileSelect(e.target.files)}
              {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
            />

            <div className="flex justify-center gap-2">
              <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={isUploading || !canSend}>
                Select Files
              </Button>
              <Button variant="outline" onClick={() => folderInputRef.current?.click()} disabled={isUploading || !canSend}>
                <FolderOpen className="mr-2 h-4 w-4" />
                Select Folder
              </Button>
            </div>
          </div>
        </Card>

        {showPicker && (
          <DirectoryPicker
            title="Select folder to index"
            initialPath={indexPath ?? indexRoots[0]}
            onSelect={path => {
              setIndexPath(path);
              setShowPicker(false);
            }}
            onClose={() => setShowPicker(false)}
          />
        )}

        {showIngestPicker && (
          <DirectoryPicker
            title="Where should sent files be saved?"
            initialPath={ingest?.folderPath ?? indexRoots[0]}
            onSelect={path => void handleChooseIngestFolder(path)}
            onClose={() => setShowIngestPicker(false)}
          />
        )}

        {files.length > 0 && (
          <>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold">
                  Files ({completedCount}/{totalCount})
                </h3>
                <p className="text-sm text-muted-foreground">
                  {totalCount} {totalCount === 1 ? "file" : "files"} in queue
                </p>
              </div>

              <div className="flex gap-2">
                <Button variant="outline" onClick={clearFiles} disabled={isUploading}>
                  Clear All
                </Button>
                <Button
                  onClick={handleUpload}
                  disabled={!canSend || isUploading || files.every((f) => f.status === "completed")}
                >
                  {isUploading ? "Sending..." : "Send All"}
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              {files.map((uploadFile) => {
                const Icon = getFileIcon(uploadFile.file.type);

                return (
                  <Card key={uploadFile.id} className="p-4">
                    <div className="flex items-start gap-4">
                      <div className="flex-shrink-0">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                          <Icon className="h-5 w-5 text-muted-foreground" />
                        </div>
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="mb-2 flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{uploadFile.file.name}</p>
                            <p className="text-sm text-muted-foreground">
                              {formatBytes(uploadFile.file.size)}
                            </p>
                          </div>

                          <div className="flex items-center gap-2">
                            {uploadFile.status === "completed" && (
                              <CheckCircle2 className="h-5 w-5 text-green-500" />
                            )}
                            {uploadFile.status === "error" && (
                              <AlertCircle className="h-5 w-5 text-destructive" />
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => removeFile(uploadFile.id)}
                              disabled={uploadFile.status === "uploading"}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>

                        {uploadFile.status === "error" && (
                          <p className="text-sm text-destructive">
                            {uploadFile.error || "Send failed"}
                          </p>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Container>
  );
}
