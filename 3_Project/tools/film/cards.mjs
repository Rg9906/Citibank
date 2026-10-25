// Title and end cards for the narrated demo, rendered from HTML at 1920x1080 (same look as the console).
//   node cards.mjs   -> ../videos/narrated/lines/title.png, end.png
import { chromium } from "playwright";

const OUT = "C:/Users/RG Saran Vishakan/Desktop/Hackathon_Projects/Citibank/queueshield/data/videos/narrated/lines";
const page = (body) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;600&display=swap">
<style>
  body { margin:0; width:1920px; height:1080px; display:flex; flex-direction:column; justify-content:center; padding:0 160px; box-sizing:border-box;
    color:#e8eef8; font-family:Inter, "Segoe UI", sans-serif;
    background: radial-gradient(1100px 700px at 78% 30%, rgba(63,208,224,.22), transparent 60%),
      radial-gradient(900px 600px at 10% 100%, rgba(255,138,61,.16), transparent 60%),
      linear-gradient(rgba(120,170,220,.05) 1px, transparent 1px) 0 0/40px 40px,
      linear-gradient(90deg, rgba(120,170,220,.05) 1px, transparent 1px) 0 0/40px 40px, #060a14; }
  .eyebrow { font-size:30px; letter-spacing:6px; text-transform:uppercase; color:#3fd0e0; font-weight:600; }
  h1 { font-family:"Space Grotesk", sans-serif; font-size:150px; margin:24px 0; line-height:1; display:flex; align-items:center; gap:36px; }
  .logo { width:110px; height:110px; border-radius:30px; background:conic-gradient(from 200deg,#3fd0e0,#6a8cff,#ff8a3d,#3fd0e0);
    box-shadow:0 0 60px rgba(63,208,224,.6); }
  .sub { font-size:46px; color:#bfcbe0; max-width:1400px; line-height:1.3; }
  .foot { position:absolute; left:160px; bottom:90px; font-size:26px; color:#8b9bb4; }
  .tag { display:inline-block; border:1px solid rgba(255,138,61,.6); color:#ffb27f; border-radius:999px; padding:4px 16px; font-size:24px; margin-right:12px; }
  ul { font-size:40px; color:#bfcbe0; line-height:1.6; padding-left:40px; }
</style></head><body>${body}</body></html>`;

const title = page(`<div class="eyebrow">Drunix Hackathon 2026 · NPCI × Citi · Real-Time Payments</div>
<h1><span class="logo"></span>QueueShield</h1>
<div class="sub">Find the sick bank before the storm locks in. A human decides. The ledger remembers.</div>
<div class="foot"><span class="tag">simulation</span>All data is synthetic. Every outcome number comes from our simulator.</div>`);

const end = page(`<div class="eyebrow">QueueShield × Drunix</div>
<h1 style="font-size:96px">Machines recommend.<br>Humans decide.<br>The ledger remembers.</h1>
<ul><li>Detect and localise the degrading bank, PSP or route</li><li>Bounded, human-approved actions; unsafe failover locked</li>
<li>Unknown payments resolved by bank attestation, pushed to every app</li></ul>
<div class="foot"><span class="tag">simulation</span>Results are from our simulator on synthetic data; the ledger ran in mock mode for this recording.</div>`);

const browser = await chromium.launch({ channel: "chrome" });
const p = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
for (const [name, html] of [["title", title], ["end", end]]) {
  await p.setContent(html, { waitUntil: "networkidle" });
  await p.screenshot({ path: `${OUT}/${name}.png` });
}
await browser.close();
console.log("cards written");
