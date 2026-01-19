// File: apps/web/app/(protected)/upload/page.tsx
"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Container } from "@/components/common/Container";
import { PageHeader } from "@/components/common/PageHeader";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

import { useUpload } from "@/components/contexts/UploadContext";
import { toast } from "@/components/ui/Toaster";
import { emitTagsUpdated } from "@/lib/tags";
import { getFileSizeError, UPLOAD_LIMIT_LABELS } from "@/lib/media/uploadLimits";

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

const formatFileSize = (bytes: number) => {
  if (!bytes) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
};

const LIBRARY_PATH = "/library";

type BatchInitItem = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  title?: string;
  tags?: string[];
};

type BatchInitResponseItem = {
  id: string;
  storageKey: string;
  putUrl: string;
};

type BatchInitResponse = {
  items: BatchInitResponseItem[];
};

async function batchInit(items: BatchInitItem[]): Promise<BatchInitResponse> {
  const res = await fetch("/api/media/batch-init", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });

  if (!res.ok) {
    let msg = `Upload init failed (${res.status})`;
    try {
      const data = await res.json();
      msg = data?.error || data?.message || msg;
    } catch {}
    throw new Error(msg);
  }

  return (await res.json()) as BatchInitResponse;
}

async function batchFinalize(ids: string[]): Promise<void> {
  const res = await fetch("/api/media/batch-finalize", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });

  if (!res.ok) {
    let msg = `Upload finalize failed (${res.status})`;
    try {
      const data = await res.json();
      msg = data?.error || data?.message || msg;
    } catch {}
    throw new Error(msg);
  }
}

/**
 * Upload with progress via XHR (fetch PUT cannot reliably report upload progress).
 * Important: Content-Type MUST match what you used when signing the presigned URL.
 */
function putWithProgress(args: {
  url: string;
  file: File;
  contentType: string;
  onProgress: (pct: number) => void;
}): Promise<void> {
  const { url, file, contentType, onProgress } = args;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);

    xhr.setRequestHeader("Content-Type", contentType);

    xhr.upload.onprogress = (evt) => {
      if (!evt.lengthComputable) return;
      const pct = Math.round((evt.loaded / evt.total) * 100);
      onProgress(pct);
    };

    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status}).`));
    };

    xhr.send(file);
  });
}

type FailedUpload = { id: string; message: string };
type CompletedUpload = { fileId: string; mediaId: string };
type UploadPlan = {
  fileId: string;
  file: File;
  contentType: string;
  init: BatchInitResponseItem;
};

function getPendingFiles(files: Array<{ id: string; file: File; status: string }>) {
  return files.filter((f) => f.status === "pending");
}

function notifyUploadStart(count: number) {
  toast(`${count} ${count === 1 ? "file" : "files"} uploading`, { variant: "default" });
}

function notifyUploadSuccess() {
  toast("Upload complete", { variant: "success" });
}

function notifyUploadFailures(count: number) {
  toast(`${count} ${count === 1 ? "file" : "files"} failed to upload`, {
    variant: "error",
    duration: 5000,
  });
}

async function uploadBatch(
  pendingFiles: UploadPlan[],
  uploadOne: (plan: UploadPlan) => Promise<void>,
): Promise<{ failed: FailedUpload[]; completed: CompletedUpload[] }> {
  const results = await Promise.allSettled(pendingFiles.map((f) => uploadOne(f)));

  const failed: FailedUpload[] = [];
  const completed: CompletedUpload[] = [];
  results.forEach((r, idx) => {
    if (r.status === "rejected") {
      const id = pendingFiles[idx].fileId;
      const message = r.reason instanceof Error ? r.reason.message : "Upload failed";
      failed.push({ id, message });
      return;
    }
    const plan = pendingFiles[idx];
    completed.push({ fileId: plan.fileId, mediaId: plan.init.id });
  });

  return { failed, completed };
}

function applyFailures(
  failed: FailedUpload[],
  updateFileStatus: (id: string, status: "error", error?: string) => void,
) {
  for (const f of failed) {
    updateFileStatus(f.id, "error", f.message);
  }
}

function exitToLibrary(clearFiles: () => void, navigate: () => void) {
  setTimeout(() => {
    clearFiles();
    navigate();
  }, 400);
}

export default function UploadPage() {
  const router = useRouter();
  const { files, addFiles, removeFile, clearFiles, updateFileProgress, updateFileStatus } =
    useUpload();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

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
    updateFileProgress(plan.fileId, 0);

    // PUT file to storage with progress
    await putWithProgress({
      url: plan.init.putUrl,
      file: plan.file,
      contentType: plan.contentType,
      onProgress: (pct) => updateFileProgress(plan.fileId, pct),
    });

    updateFileStatus(plan.fileId, "completed");
    updateFileProgress(plan.fileId, 100);
  };

  const handleUpload = async () => {
    const pendingFiles = getPendingFiles(files);
    if (pendingFiles.length === 0) return;

    setIsUploading(true);
    notifyUploadStart(pendingFiles.length);

    try {
      const initPayload = pendingFiles.map((pending) => {
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

      if (completed.length > 0) {
        emitTagsUpdated();
        try {
          await batchFinalize(completed.map((item) => item.mediaId));
        } catch (err) {
          const message = err instanceof Error ? err.message : "Upload finalize failed.";
          for (const item of completed) {
            updateFileStatus(item.fileId, "error", message);
          }
          applyFailures(failed, (id, _status, error) => updateFileStatus(id, "error", error));
          notifyUploadFailures(completed.length + failed.length);
          return;
        }
      }

      if (failed.length === 0) {
        notifyUploadSuccess();
        exitToLibrary(clearFiles, () => router.push(`${LIBRARY_PATH}?uploaded=1`));
        return;
      }

      applyFailures(failed, (id, _status, error) => updateFileStatus(id, "error", error));
      notifyUploadFailures(failed.length);
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
              File size limits: photos up to {UPLOAD_LIMIT_LABELS.photo}, documents up to{" "}
              {UPLOAD_LIMIT_LABELS.document}, other files up to {UPLOAD_LIMIT_LABELS.other} (hard cap).
            </p>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleFileSelect(e.target.files)}
              accept="image/*,video/*,.pdf,.doc,.docx"
            />

            <Button onClick={() => fileInputRef.current?.click()} disabled={isUploading}>
              Select Files
            </Button>
          </div>
        </Card>

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
                              {formatFileSize(uploadFile.file.size)}
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

                        {uploadFile.status === "uploading" && (
                          <div className="space-y-1">
                            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                              <div
                                className="h-full bg-primary transition-all duration-300"
                                style={{ width: `${uploadFile.progress}%` }}
                              />
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {uploadFile.progress}% uploaded
                            </p>
                          </div>
                        )}

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
