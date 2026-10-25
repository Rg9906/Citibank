// Build and render the v2 (white, dense) pitch deck.
//   node render_deck2.mjs            -> deck.html + slide PNGs (out/) + overflow report
//   node render_deck2.mjs --pdf      -> also QueueShield_pitch_deck.pdf + notes.json in data/deck_render/
//   node render_deck2.mjs --only 3,5 -> PNGs for those slides only (1-based)
// Sources: data/deck_v2/parts/*.html, concatenated in file-name order. Speaker notes: <aside class="notes"> per slide.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const deckDir = path.resolve(here, "../deck_v2");
const outDir = path.join(deckDir, "out");
const renderDir = path.resolve(here, "../deck_render");
const args = process.argv.slice(2);
const wantPdf = args.includes("--pdf");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(",").map(Number)) : null;

const parts = fs.readdirSync(path.join(deckDir, "parts")).filter((f) => f.endsWith(".html")).sort();
const html = parts.map((f) => fs.readFileSync(path.join(deckDir, "parts", f), "utf8")).join("\n")
  .replace("</style>", "aside.notes{display:none}</style>");
const htmlPath = path.join(deckDir, "deck.html");
fs.writeFileSync(htmlPath, html);
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("console", (m) => { if (m.type() === "error") console.log("console error:", m.text()); });
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.goto("file:///" + htmlPath.replace(/\\/g, "/"), { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__deckReady === true, null, { timeout: 30000 });
await page.evaluate(() => document.fonts.ready);
const report = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll(".slide").forEach((s, i) => {
    const sr = s.getBoundingClientRect();
    const bad = [];
    s.querySelectorAll("*").forEach((e) => {
      if (e.closest("aside.notes") || e.closest("svg")) return;
      const r = e.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      if (r.right > sr.right - 30 + 1 || r.bottom > sr.bottom - 14 + 1) bad.push(`${e.tagName}.${e.className} edge`);
      const cs = getComputedStyle(e);
      if (e.scrollHeight > e.clientHeight + 2 && cs.overflow !== "visible" && e.tagName !== "IMG") bad.push(`${e.tagName}.${e.className} clipped ${e.scrollHeight - e.clientHeight}px`);
    });
    const icons = s.querySelectorAll("i[data-lucide]").length;
    out.push({ slide: i + 1, id: s.id, issues: [...new Set(bad)].slice(0, 6), unrenderedIcons: icons });
  });
  return out;
});
for (const r of report) if (r.issues.length || r.unrenderedIcons) console.log(JSON.stringify(r));
const slides = await page.$$(".slide");
for (let i = 0; i < slides.length; i++) {
  if (only && !only.has(i + 1)) continue;
  await slides[i].screenshot({ path: path.join(outDir, `slide_${String(i + 1).padStart(2, "0")}.png`) });
}
if (wantPdf) {
  fs.mkdirSync(renderDir, { recursive: true });
  await page.pdf({ path: path.join(renderDir, "QueueShield_pitch_deck.pdf"), width: "1920px", height: "1080px", printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  const notes = await page.evaluate(() => [...document.querySelectorAll(".slide")].map((s) => s.querySelector("aside.notes")?.textContent.trim().replace(/\s+/g, " ") ?? ""));
  fs.writeFileSync(path.join(renderDir, "notes.json"), JSON.stringify(notes, null, 1));
  for (const f of fs.readdirSync(renderDir)) if (/^slide_\d+\.png$/.test(f)) fs.rmSync(path.join(renderDir, f));
  for (const f of fs.readdirSync(outDir)) if (/^slide_\d+\.png$/.test(f)) fs.copyFileSync(path.join(outDir, f), path.join(renderDir, f));
}
await browser.close();
console.log(JSON.stringify({ slides: slides.length, out: outDir, pdf: wantPdf }));
