"use client";

import { useRef, useState } from "react";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type Attachment } from "@wdash/shared";

type Pending = { key: string; name: string; size: number; status: "uploading" | "ready" | "error"; meta?: Attachment; error?: string };

/**
 * Files upload as soon as they're picked, so submitting stays instant.
 * `endpoint` is /api/uploads (before a job exists) or /api/jobs/:id/files.
 */
export function useUploads(endpoint: string) {
  const [items, setItems] = useState<Pending[]>([]);
  const patch = (key: string, p: Partial<Pending>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  function add(files: FileList | File[]) {
    const list = [...files];
    const room = MAX_ATTACHMENTS - items.length;
    for (const [i, file] of list.entries()) {
      const key = `${Date.now()}-${i}-${file.name}`;
      if (i >= room) {
        setItems((xs) => [...xs, { key, name: file.name, size: file.size, status: "error", error: `Max ${MAX_ATTACHMENTS} files` }]);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setItems((xs) => [...xs, { key, name: file.name, size: file.size, status: "error", error: `Over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB` }]);
        continue;
      }
      setItems((xs) => [...xs, { key, name: file.name, size: file.size, status: "uploading" }]);
      void upload(endpoint, file).then(
        (meta) => patch(key, { status: "ready", meta }),
        (e: Error) => patch(key, { status: "error", error: e.message }),
      );
    }
  }

  return {
    items,
    add,
    remove: (key: string) => setItems((xs) => xs.filter((x) => x.key !== key)),
    clear: () => setItems([]),
    busy: items.some((x) => x.status === "uploading"),
    ready: items.filter((x) => x.status === "ready").map((x) => x.meta!),
  };
}

async function upload(endpoint: string, file: File): Promise<Attachment> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "x-file-name": encodeURIComponent(file.name), "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (res.status === 401) {
    window.location.href = "/signin";
    throw new Error("signed out");
  }
  const data = (await res.json().catch(() => ({}))) as Attachment & { error?: string };
  if (!res.ok) throw new Error(data.error ?? (res.status === 413 ? "Too large" : `HTTP ${res.status}`));
  return data;
}

export function AttachButton({ onFiles, label = "Attach files", compact = false }: { onFiles: (f: FileList) => void; label?: string; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={compact ? "btn shrink-0 px-2" : "btn"}
        title={label}
        aria-label={label}
        onClick={() => input.current?.click()}
      >
        📎{compact ? "" : ` ${label}`}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );
}

export function FileChips({ items, onRemove }: { items: Pending[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((x) => (
        <li
          key={x.key}
          className={`flex max-w-full items-center gap-2 rounded-lg border px-2 py-1 text-xs ${x.status === "error" ? "border-bad text-bad" : "border-line"}`}
        >
          <span className="truncate">{x.meta?.name ?? x.name}</span>
          <span className="shrink-0 text-muted">{x.status === "uploading" ? "uploading…" : x.status === "error" ? x.error : fmtSize(x.size)}</span>
          <button type="button" className="shrink-0 text-muted hover:text-fg" aria-label={`Remove ${x.name}`} onClick={() => onRemove(x.key)}>
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Lets a whole area accept dropped files. */
export function dropProps(onFiles: (f: FileList) => void) {
  return {
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes("Files")) e.preventDefault();
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      onFiles(e.dataTransfer.files);
    },
  };
}

export function fmtSize(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}
