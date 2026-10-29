export * from "./keys.js";
export * from "./schema.js";
export * from "./attention.js";
export * from "./upstash.js";

/** Short sortable id: base36 time + random. */
export function newId(prefix = ""): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}${t}${r}`;
}

export function truncate(s: string, max = 4000): string {
  return s.length > max ? `${s.slice(0, max)}\n… [${s.length - max} more chars]` : s;
}
