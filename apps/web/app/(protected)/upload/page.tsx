"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Container } from "@/components/common/Container";
import { PageHeader } from "@/components/common/PageHeader";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DirectoryPicker } from "@/components/settings/DirectoryPicker";

import { useUpload } from "@/components/contexts/UploadContext";
import { useIndexProgress } from "@/components/contexts/IndexProgressContext";
import { usePreferences } from "@/hooks/usePreferences";
import { toast } from "@/components/ui/Toaster";
import { emitTagsUpdated } from "@/lib/tags";
import { getFileSizeError } from "@/lib/media/uploadLimits";
import { formatBytes } from "@/lib/media/utils";
import { getIndexRoots } from "@/lib/media/indexing";
import {
  batchInit, batchFinalize, getPendingFiles, notifyUploadStart, notifyUploadSuccess,
  notifyUploadFailures, chunkArray, uploadBatch, applyFailures, exitToLibrary,
  BATCH_CHUNK_SIZE,
  type BatchInitItem, type UploadPlan, type FailedUpload, type CompletedUpload,
} from "@/lib/media/upload";

import {
  Upload,
  X,
  Image as ImageIcon,
  Video,
  FileText,
  ArrowLeft,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

const getFileIcon = (type: string) => {
  if (type.startsWith("image/")) return ImageIcon;
  if (type.startsWith("video/")) return Video;
  return FileText;
};

const LIBRARY_PATH = "/library";

export default function UploadPage() {
  const router = useRouter();
  const { files, addFiles, removeFile, clearFiles, updateFileStatus } =
    useUpload();
  const { prefs } = usePreferences();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // In-place indexing (only shown when INDEX_ALLOWED_ROOTS is configured).
  const [indexEnabled, setIndexEnabled] = useState(false);
  const [indexRoots, setIndexRoots] = useState<string[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [indexPath, setIndexPath] = useState<string | null>(null);
  const [recursive, setRecursive] = useState(true);
  const [isStarting, setIsStarting] = useState(false);

  // Scan progress is tracked globally so it survives navigation/reload; completion
  // toasts + sidebar refreshes are handled by the provider.
  const { status: indexStatus, start: startIndexScan, stop: stopIndexScan } = useIndexProgress();
  const isIndexing = isStarting || (!!indexStatus && !indexStatus.done && indexStatus.state !== "failed");

  useEffect(() => {
    void getIndexRoots().then(r => {
      setIndexEnabled(r.enabled);
      setIndexRoots(r.roots);
    });
  }, []);

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

  const completedCount = useMemo(
    () => files.filter((f) => f.status === "completed").length,
    [files],
  );
  const totalCount = files.length;

  const handleFileSelect = (selectedFiles: FileList | null) => {
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
          : `${errors.length} files exceed the upload limits. First: ${errors[0]}`;
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
    setIsDragging(false);
    handleFileSelect(e.dataTransfer.files);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer?.types?.includes("Files")) return;
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const uploadOne = async (plan: UploadPlan) => {
    updateFileStatus(plan.fileId, "uploading");

    // Filesystem-backed storage returns a same-origin proxy URL (/api/storage/blob/...)
    // that needs the auth cookie; S3/MinIO returns an absolute presigned URL that must
    // NOT carry credentials. Send cookies only for relative (same-origin) targets.
    const isProxyUpload = plan.init.putUrl.startsWith("/");

    let res: Response;
    try {
      res = await fetch(plan.init.putUrl, {
        method: "PUT",
        headers: { "Content-Type": plan.contentType },
        body: plan.file,
        ...(isProxyUpload ? { credentials: "include" as const } : {}),
      });
    } catch (err) {
      // Network-level failure (offline, DNS, CORS) — distinguish from an HTTP error status.
      throw new Error(
        `Upload failed: could not reach storage (${err instanceof Error ? err.message : "network error"}).`,
      );
    }

    if (!res.ok) {
      const detail = isProxyUpload ? await res.text().catch(() => "") : "";
      throw new Error(
        `Upload failed (${res.status}${res.statusText ? ` ${res.statusText}` : ""})${detail ? `: ${detail.slice(0, 200)}` : ""}.`,
      );
    }

    updateFileStatus(plan.fileId, "completed");
  };

  const handleUpload = async () => {
    const pendingFiles = getPendingFiles(files);
    if (pendingFiles.length === 0) return;

    setIsUploading(true);
    notifyUploadStart(pendingFiles.length);

    const preErrorCount = files.filter(f => f.status === "error").length;
    const allFailed: FailedUpload[] = [];
    const allCompleted: CompletedUpload[] = [];

    try {
      const chunks = chunkArray(pendingFiles, BATCH_CHUNK_SIZE);

      for (const chunk of chunks) {
        const initPayload = chunk.map((pending) => {
          const contentType =
            pending.file.type && pending.file.type.trim()
              ? pending.file.type
              : "application/octet-stream";
          const title = pending.file.name.replace(/\.[^/.]+$/, "");
          return {
            fileId: pending.id,
            file: pending.file,
            contentType,
            initBody: {
              filename: pending.file.name,
              mimeType: contentType,
              sizeBytes: pending.file.size,
              title,
              tags: [],
              autoTagOnUpload: prefs.autoTagOnUpload,
            } satisfies BatchInitItem,
          };
        });

        const init = await batchInit(initPayload.map((item) => item.initBody));
        if (!init?.items || init.items.length !== initPayload.length) {
          throw new Error("Upload init returned unexpected item count.");
        }

        const plans: UploadPlan[] = initPayload.map((item, index) => ({
          fileId: item.fileId,
          file: item.file,
          contentType: item.contentType,
          init: init.items[index],
        }));

        const { failed, completed } = await uploadBatch(plans, uploadOne);
        allFailed.push(...failed);
        applyFailures(failed, (id, _status, error) => updateFileStatus(id, "error", error));

        if (completed.length > 0) {
          try {
            await batchFinalize(completed.map((item) => item.mediaId), prefs.autoUnpackArchives);
            allCompleted.push(...completed);
          } catch (err) {
            const message = err instanceof Error ? err.message : "Upload finalize failed.";
            for (const item of completed) {
              updateFileStatus(item.fileId, "error", message);
            }
            notifyUploadFailures(completed.length + allFailed.length);
            return;
          }
        }
      }

      const totalFailed = allFailed.length + preErrorCount;
      if (totalFailed === 0) {
        emitTagsUpdated();
        notifyUploadSuccess();
        exitToLibrary(clearFiles, () => router.push(`${LIBRARY_PATH}?uploaded=1`));
        return;
      }

      for (const item of allCompleted) removeFile(item.fileId);
      if (allFailed.length < pendingFiles.length) emitTagsUpdated();
      notifyUploadFailures(totalFailed);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed.";
      for (const pending of pendingFiles) {
        updateFileStatus(pending.id, "error", message);
      }
      notifyUploadFailures(pendingFiles.length);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Container className="py-6">
      <PageHeader
        title="Upload Media"
        description="Upload your media files"
        actions={
          <Button variant="outline" size="sm" onClick={() => router.push(LIBRARY_PATH)}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Library
          </Button>
        }
      />

      <div className="space-y-6">
        <Card
          className={`border-2 border-dashed transition-colors ${
            isDragging ? "border-primary bg-primary/5" : "border-border"
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <div className="p-12 text-center">
            <Upload className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
            <h3 className="mb-2 text-lg font-semibold">Drop files here or click to browse</h3>
            <p className="mb-2 text-sm text-muted-foreground">
              Support for images, videos, and documents
            </p>
            <p className="mb-4 text-xs text-muted-foreground">
              2 GB max per file
            </p>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleFileSelect(e.target.files)}
            />

            <Button onClick={() => fileInputRef.current?.click()} disabled={isUploading}>
              Select Files
            </Button>
          </div>
        </Card>

        {indexEnabled && (
          <Card className="p-6">
            <h3 className="mb-1 text-lg font-semibold">Index a folder already on the server</h3>
            <p className="mb-1 text-sm text-muted-foreground">
              Vault generates thumbnails and text search for files where they sit — no copy is made and
              the source folder is never modified.
            </p>

            {indexRoots.length > 0 && (
              <div className="mb-4 space-y-1">
                <p className="text-xs text-muted-foreground">Allowed roots — click to select:</p>
                {indexRoots.map(root => (
                  <button
                    key={root}
                    onClick={() => setIndexPath(root)}
                    disabled={isIndexing}
                    className={`block w-full rounded border px-3 py-1.5 text-left font-mono text-sm transition-colors hover:bg-accent ${
                      indexPath === root ? "border-primary bg-primary/10" : "border-border"
                    }`}
                  >
                    {root}
                  </button>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" onClick={() => setShowPicker(true)} disabled={isIndexing}>
                {indexPath ? "Change folder…" : "Choose subfolder…"}
              </Button>
              {indexPath && !indexRoots.includes(indexPath) && (
                <span className="break-all font-mono text-sm">{indexPath}</span>
              )}
            </div>

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

                <div className="mt-4 flex items-center gap-3">
                  <Button onClick={handleStartIndex} disabled={isIndexing}>
                    {isIndexing ? "Indexing…" : "Start indexing"}
                  </Button>
                  {isIndexing && (
                    <Button variant="outline" onClick={() => void stopIndexScan()}>
                      Stop
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
          </Card>
        )}

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
                  disabled={isUploading || files.every((f) => f.status === "completed")}
                >
                  {isUploading ? "Uploading..." : "Upload All"}
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
                            {uploadFile.error || "Upload failed"}
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
