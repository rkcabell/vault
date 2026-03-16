"use client";

import { createContext, useContext, useState, ReactNode } from 'react';

export interface UploadFile {
  id: string;
  file: File;
  status: 'pending' | 'uploading' | 'completed' | 'error';
  error?: string;
}

interface UploadContextType {
  files: UploadFile[];
  addFiles: (files: File[], opts?: { status?: UploadFile['status']; error?: string }) => void;
  removeFile: (id: string) => void;
  clearFiles: () => void;
  updateFileStatus: (id: string, status: UploadFile['status'], error?: string) => void;
}

const UploadContext = createContext<UploadContextType | undefined>(undefined);

export function UploadProvider({ children }: { children: ReactNode }) {
  const [files, setFiles] = useState<UploadFile[]>([]);

  const addFiles = (newFiles: File[], opts?: { status?: UploadFile['status']; error?: string }) => {
    const uploadFiles: UploadFile[] = newFiles.map((file) => ({
      id: `${file.name}-${Date.now()}-${Math.random()}`,
      file,
      status: opts?.status ?? 'pending',
      error: opts?.error,
    }));
    setFiles((prev) => [...prev, ...uploadFiles]);
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const clearFiles = () => {
    setFiles([]);
  };

  const updateFileStatus = (id: string, status: UploadFile['status'], error?: string) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, status, error } : f))
    );
  };

  return (
    <UploadContext.Provider
      value={{
        files,
        addFiles,
        removeFile,
        clearFiles,
        updateFileStatus,
      }}
    >
      {children}
    </UploadContext.Provider>
  );
}

export function useUpload() {
  const context = useContext(UploadContext);
  if (context === undefined) {
    throw new Error('useUpload must be used within an UploadProvider');
  }
  return context;
}
