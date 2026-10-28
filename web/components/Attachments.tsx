"use client";

import { useRef, useState } from "react";
import { BIG_FILE_WARN_BYTES, FILE_CHUNK_TTL_SECONDS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, UPSTASH_FREE_STORAGE_BYTES, storedBytes, type Attachment } from "@wdash/shared";

type Pending = { key: string; name: string; size: number; status: "uploading" | "ready" | "error"; meta?: Attachment; error?: string; percent?: number };

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
      void upload(endpoint, file, (percent) => patch(key, { percent })).then(
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

/**
 * Sends a file in pieces (each request stays under Vercel's 4.5 MB body limit), so files up to
 * MAX_ATTACHMENT_BYTES work. On a job's files endpoint the finished upload is then attached to the job.
 */
async function upload(endpoint: string, file: File, onProgress: (percent: number) => void): Promise<Attachment> {
  const { meta, chunkBytes } = await call<{ meta: Attachment; chunkBytes: number }>("/api/uploads/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name, size: file.size, type: file.type || "application/octet-stream" }),
  });
  const chunks = meta.chunks ?? 1;
  for (let n = 0; n < chunks; n++) {
    const piece = file.slice(n * chunkBytes, Math.min(file.size, (n + 1) * chunkBytes));
    // One retry per piece: a flaky school or phone connection shouldn't lose a 90 MB upload.
    for (let attempt = 0; ; attempt++) {
      try {
        await call(`/api/uploads/${encodeURIComponent(meta.id)}/${n}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: piece });
        break;
      } catch (e) {
        if (attempt >= 1 || (e as Error).message === "signed out") throw e;
      }
    }
    onProgress(Math.round(((n + 1) / chunks) * 100));
  }
  const done = await call<Attachment>(`/api/uploads/${encodeURIComponent(meta.id)}/complete`, { method: "POST" });
  if (endpoint === "/api/uploads") return done;
  return call<Attachment>(endpoint, { method: "POST", headers: { "x-upload-id": meta.id } });
}

async function call<T = unknown>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 401) {
    window.location.href = "/signin";
    throw new Error("signed out");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
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
  // Big files are stored in Redis (as base64, ~4/3 of their size) until their pieces expire.
  const big = items.filter((x) => x.status !== "error" && x.size >= BIG_FILE_WARN_BYTES);
  const stored = big.reduce((a, x) => a + storedBytes(x.size), 0);
  const mb = (b: number) => Math.round(b / 1024 / 1024);
  return (
    <>
    <ul className="flex flex-wrap gap-2">
      {items.map((x) => (
        <li
          key={x.key}
          className={`flex max-w-full items-center gap-2 rounded-lg border px-2 py-1 text-xs ${x.status === "error" ? "border-bad text-bad" : "border-line"}`}
        >
          <span className="truncate">{x.meta?.name ?? x.name}</span>
          <span className="shrink-0 text-muted">{x.status === "uploading" ? `uploading${x.percent ? ` ${x.percent}%` : "…"}` : x.status === "error" ? x.error : fmtSize(x.size)}</span>
          <button type="button" className="shrink-0 text-muted hover:text-fg" aria-label={`Remove ${x.name}`} onClick={() => onRemove(x.key)}>
            ✕
          </button>
        </li>
      ))}
    </ul>
    {big.length > 0 && (
      <p className="rounded-lg border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
        ⚠ {big.length === 1 ? "This big file takes" : `These ${big.length} big files take`} about {mb(stored)} MB of your {mb(UPSTASH_FREE_STORAGE_BYTES)} MB free Upstash storage for{" "}
        {FILE_CHUNK_TTL_SECONDS / 86400} days.{stored > UPSTASH_FREE_STORAGE_BYTES / 2 ? " That's over half of it, so another big upload may fail until these expire." : ""}
      </p>
    )}
    </>
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
