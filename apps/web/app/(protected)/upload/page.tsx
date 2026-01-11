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

type InitUploadBody = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  title: string;
  tags: string[];
};

// Matches your Fastify response: { id, uploadUrl, storageKey }
type InitUploadResponse = {
  id: string;
  uploadUrl: string;
  storageKey: string;
};

async function initUpload(body: InitUploadBody): Promise<InitUploadResponse> {
  // Fastify is registered under /api/media
  const res = await fetch("/api/media", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let msg = `Upload init failed (${res.status})`;
    try {
      const data = await res.json();
      msg = data?.error || data?.message || msg;
    } catch {}
    throw new Error(msg);
  }

  return (await res.json()) as InitUploadResponse;
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
  pendingFiles: Array<{ id: string; file: File }>,
  uploadOne: (id: string, file: File) => Promise<void>,
): Promise<{ failed: FailedUpload[] }> {
  const results = await Promise.allSettled(pendingFiles.map((f) => uploadOne(f.id, f.file)));

  const failed: FailedUpload[] = [];
  results.forEach((r, idx) => {
    if (r.status === "rejected") {
      const id = pendingFiles[idx].id;
      const message = r.reason instanceof Error ? r.reason.message : "Upload failed";
      failed.push({ id, message });
    }
  });

  return { failed };
}

function applyFailures(
  failed: FailedUpload[],
  updateFileStatus: (id: string, status: "error", error?: string) => void,
) {
  for (const f of failed) {
    updateFileStatus(f.id, "error", f.message);
  }
}

function exitToOverview(clearFiles: () => void, navigate: () => void) {
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
    addFiles(Array.from(selectedFiles));
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

  const uploadOne = async (fileId: string, file: File) => {
    updateFileStatus(fileId, "uploading");
    updateFileProgress(fileId, 0);

    // Ensure the Content-Type we sign matches what we PUT with
    const contentType = file.type && file.type.trim() ? file.type : "application/octet-stream";

    // 1) Init upload in API (creates DB row tied to current user + returns presigned PUT)
    const title = file.name.replace(/\.[^/.]+$/, "");
    const init = await initUpload({
      filename: file.name,
      mimeType: contentType,
      sizeBytes: file.size,
      title,
      tags: [],
    });

    // 2) PUT file to storage with progress
    await putWithProgress({
      url: init.uploadUrl,
      file,
      contentType,
      onProgress: (pct) => updateFileProgress(fileId, pct),
    });

    // 3) Mark completed locally (server will handle thumb/text states via workers)
    updateFileStatus(fileId, "completed");
    updateFileProgress(fileId, 100);
  };

  const handleUpload = async () => {
    const pendingFiles = getPendingFiles(files);
    if (pendingFiles.length === 0) return;

    setIsUploading(true);
    notifyUploadStart(pendingFiles.length);

    try {
      const { failed } = await uploadBatch(pendingFiles, uploadOne);

      if (failed.length === 0) {
        notifyUploadSuccess();
        exitToOverview(clearFiles, () => router.push("/overview?uploaded=1"));
        return;
      }

      applyFailures(failed, (id, _status, error) => updateFileStatus(id, "error", error));
      notifyUploadFailures(failed.length);
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
          <Button variant="outline" size="sm" onClick={() => router.push("/overview")}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Overview
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
            <p className="mb-4 text-sm text-muted-foreground">
              Support for images, videos, and documents
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
