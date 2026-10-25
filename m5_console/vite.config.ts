import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

// M5-T05: serve ../data/recordings/<name>.jsonl at /recordings/<name>.jsonl (dev and preview). File names only.
function recordings(): Plugin {
  const dir = path.resolve(__dirname, "../data/recordings");
  const handler = (req: { url?: string }, res: { statusCode: number; setHeader(k: string, v: string): void; end(b?: string): void },
    next: () => void) => {
    const m = /^\/recordings\/([A-Za-z0-9._-]+\.jsonl)$/.exec((req.url ?? "").split("?")[0]);
    if (!m) return next();
    const file = path.join(dir, m[1]);
    if (!fs.existsSync(file)) { res.statusCode = 404; res.end("not found"); return; }
    res.setHeader("content-type", "application/x-ndjson");
    res.end(fs.readFileSync(file, "utf8"));
  };
  return { name: "qs-recordings", configureServer: (s) => { s.middlewares.use(handler); },
    configurePreviewServer: (s) => { s.middlewares.use(handler); } };
}

// The console reads ../contracts/fixtures for MOCK fallback, so the dev server may serve the parent folder.
export default defineConfig({
  plugins: [react(), recordings()],
  server: { port: 8000, host: "127.0.0.1", fs: { allow: [".."] } },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
