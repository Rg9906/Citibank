// Render the pitch deck's slide sources (the claude.ai Slides artifact files) to PDF + per-slide PNGs, locally.
//   node render_deck.mjs <deck project folder> <out folder>
// Shims the deck format's custom elements (x-shape arrows, x-icon) and maps uploaded /_blob images to local shots.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [deckDir, outDir] = process.argv.slice(2);
const SHOTS = "C:/Users/RG Saran Vishakan/Desktop/Hackathon_Projects/Citibank/queueshield/data/videos/shots";
const BLOBS = {
  d9d66890bb6e7b9d891f3c8d43f6c02e: "bank_recommendation.png",
  "1945238c250e203fe6aa613129ac7bf0": "split_storm.png",
  "9658784dad4fcc7a0785b778866a86db": "split_final.png",
  "1f1819b2e9a68b26341a946f47ae92ca": "blocked_failover_mock.png",
};
const ICONS = {                                                // simple 24x24 stroke icons
  Search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  Activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  Users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M16 4a4 4 0 010 8M22 21c0-3-2-5-5-6"/>',
  Link: '<path d="M10 14a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1"/><path d="M14 10a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/>',
  Lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  CheckCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  Wrench: '<path d="M14 7a4 4 0 005 5l-9 9a2 2 0 01-3-3l9-9a4 4 0 01-2-2z"/>',
};
const deck = JSON.parse(fs.readFileSync(path.join(deckDir, "project/deck.json"), "utf8"));
const fonts = Object.values(deck.faces).map((f) => `<link rel="stylesheet" href="${f.href}">`).join("");
const css = `
  @page { size: 1920px 1080px; margin: 0; }
  html, body { margin: 0; padding: 0; background: #0B1020; }
  section { width: 1920px; height: 1080px; box-sizing: border-box; position: relative; overflow: hidden; page-break-after: always; break-after: page; }
  section *, section *::before { box-sizing: border-box; }
  h1, h2, h3, p, ul, ol { margin: 0; }
  h1 { font-size: 96px; font-weight: 600; line-height: 1.1; } h2 { font-size: 64px; font-weight: 600; line-height: 1.15; }
  h3 { font-size: 44px; font-weight: 600; line-height: 1.2; } p { font-size: 32px; line-height: 1.4; }
  ul, ol { padding-left: 1.2em; } li { margin: 0.15em 0; }
  section div:not([style*="display"]) { display: flex; flex-direction: column; }   /* deck format: no display = column */
  aside { display: none; }
  table { border-collapse: collapse; width: 100%; } th, td { padding: 0.35em 0.6em; border-bottom: 1px solid rgba(90,102,128,.35); }
  x-shape { display: block; flex: none; }
  x-shape[kind="arrow-right"] { clip-path: polygon(0 30%, 60% 30%, 60% 0, 100% 50%, 60% 100%, 60% 70%, 0 70%); }
  x-shape[kind="arrow-left"] { clip-path: polygon(100% 30%, 40% 30%, 40% 0, 0 50%, 40% 100%, 40% 70%, 100% 70%); }
  x-icon { display: inline-block; flex: none; } x-icon svg { width: 100%; height: 100%; }`;
let body = "";
for (const id of deck.order) {
  let html = fs.readFileSync(path.join(deckDir, "project/slides", `${id}.html`), "utf8");
  html = html.replace(/\/_blob\/([0-9a-f]{32})/g, (_m, b) => `file:///${SHOTS}/${BLOBS[b]}`);
  html = html.replace(/<x-icon name="(\w+)" style="([^"]*)"><\/x-icon>/g, (_m, n, st) =>
    `<x-icon style="${st}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] ?? ""}</svg></x-icon>`);
  body += html;
}
const page = `<!doctype html><html><head><meta charset="utf-8">${fonts}<style>${css}</style></head><body>${body}</body></html>`;
fs.mkdirSync(outDir, { recursive: true });
const htmlPath = path.join(outDir, "deck_render.html");
fs.writeFileSync(htmlPath, page);

const browser = await chromium.launch({ channel: "chrome" });
const p = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto(`file:///${htmlPath.replace(/\\/g, "/")}`, { waitUntil: "networkidle" });
await p.evaluate(() => document.fonts.ready);
const slides = await p.$$("section");
for (let i = 0; i < slides.length; i++) {
  await slides[i].screenshot({ path: path.join(outDir, `slide_${String(i + 1).padStart(2, "0")}.png`) });
}
await p.pdf({ path: path.join(outDir, "QueueShield_pitch_deck.pdf"), width: "1920px", height: "1080px", printBackground: true,
  margin: { top: 0, right: 0, bottom: 0, left: 0 } });
const notes = deck.order.map((id) => {
  const html = fs.readFileSync(path.join(deckDir, "project/slides", `${id}.html`), "utf8");
  return (/<aside>([\s\S]*?)<\/aside>/.exec(html)?.[1] ?? "").trim();
});
fs.writeFileSync(path.join(outDir, "notes.json"), JSON.stringify(notes, null, 1));
await browser.close();
console.log(JSON.stringify({ slides: slides.length, out: outDir }));
