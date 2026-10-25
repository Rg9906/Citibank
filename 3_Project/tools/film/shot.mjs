// Quick check: open a console URL at 1920x1080, wait, screenshot, print page errors.
//   node shot.mjs "<url>" <seconds> <out.png>
import { chromium } from "playwright";

const [url, secs = "10", out = "shot.png"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", args: ["--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`); });
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(Number(secs) * 1000);
await page.screenshot({ path: out });
const scroll = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth }));
const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now();
  const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res(Math.round(n / 2)); }; requestAnimationFrame(f); }));
console.log(JSON.stringify({ out, scroll, fps, errors: [...new Set(errors)].slice(0, 8) }));
await browser.close();
