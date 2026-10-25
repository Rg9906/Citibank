import fs from "node:fs";
import path from "node:path";
import type { Connect, Plugin } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Recordings (M5-T05) and finished runs (Arena, M5-T06) are read from ../data, served read-only at /recordings and
// /runs. Names are restricted to [A-Za-z0-9_.-] so nothing outside those folders can be reached.
const DATA = path.resolve(__dirname, "../data");
const SAFE = /^[A-Za-z0-9_.-]+$/;

function serveData(): Plugin {
  const mw: Connect.NextHandleFunction = (req, res, next) => {
    const m = /^\/(recordings|runs)\/([^?]*)/.exec(req.url ?? "");
    if (!m) return next();
    if (m[1] === "runs" && m[2] === "index.json") {           // the same summary M2 serves at /v1/results
      const dir = path.join(DATA, "runs");
      const out = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => SAFE.test(d))
        .map((d) => path.join(dir, d, "result.json")).filter((f) => fs.existsSync(f))
        .map((f) => { const r = JSON.parse(fs.readFileSync(f, "utf8")); return { run_id: r.run_id, scenario: r.scenario, seed: r.seed, universe: r.universe, metrics: r.metrics }; }) : [];
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(out));
    }
    const parts = decodeURIComponent(m[2]).split("/").filter(Boolean);
    if (!parts.length || !parts.every((p) => SAFE.test(p) && p !== "..")) { res.statusCode = 400; return res.end(); }
    const file = path.join(DATA, m[1], ...parts);
    if (!file.startsWith(path.join(DATA, m[1]) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("content-type", file.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8");
    fs.createReadStream(file).pipe(res);
  };
  return {
    name: "qs-serve-data",
    configureServer: (s) => { s.middlewares.use(mw); },
    configurePreviewServer: (s) => { s.middlewares.use(mw); },
  };
}

// The console reads ../contracts/fixtures for MOCK fallback, so the dev server may serve the parent folder.
export default defineConfig({
  plugins: [react(), serveData()],
  server: { port: 8000, host: "127.0.0.1", fs: { allow: [".."] } },
  preview: { port: 8000, host: "127.0.0.1" },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
