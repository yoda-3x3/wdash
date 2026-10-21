// Copies MediaPipe's WebAssembly runtime into public/ so the gesture recognizer loads from this site.
// (School networks often block CDNs; *.vercel.app is what's reachable.) Runs before every build.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// The package's exports hide package.json; its main bundle sits at the package root.
const pkg = dirname(require.resolve("@mediapipe/tasks-vision"));
const out = join(here, "..", "public", "mediapipe", "wasm");
mkdirSync(out, { recursive: true });
// The SIMD build, plus the no-SIMD fallback for older browsers.
for (const f of ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"]) {
  const src = join(pkg, "wasm", f);
  if (!existsSync(src)) throw new Error(`missing ${src}`);
  copyFileSync(src, join(out, f));
}
console.log(`copied MediaPipe wasm to ${out}`);
