import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.OAR_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = "/tmp/onaroll-work/test-results";
const API = "https://onaroll-posts.dent-pete.workers.dev";
const PORT = 47149;
const KEY = process.env.ONAROLL_BOARD_KEY;
if (!KEY) {
  console.error("missing board key env");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let filePath = path.join(ROOT, decodeURIComponent(url.pathname));
    if (url.pathname === "/") filePath = path.join(ROOT, "index.html");
    const rel = path.relative(ROOT, filePath);
    if (rel.startsWith("..")) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

async function api(method, pathName, body) {
  const headers = { "X-Board-Key": KEY, Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; OnARollBoard/1.0)" };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(API + pathName, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

function postHeadline(state, id) {
  const p = state?.[id] || {};
  return `${p.line1 || ""} ${p.line2 || ""}`.replace(/\s+/g, " ").trim();
}

async function readBoard(page) {
  return page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("oar-jon-board-v27") || "{}"); }
    catch { return {}; }
  });
}

const server = await startServer();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
});
await context.addInitScript((code) => {
  localStorage.setItem("oar-jon-board-code", code);
  localStorage.setItem("oar-jon-view", "simple");
}, KEY);

const page = await context.newPage();
// Never dump request headers (they include the key)
page.on("console", (msg) => {
  const t = msg.text();
  if (/board-key|board code|X-Board-Key/i.test(t)) return;
  if (msg.type() === "error") console.log("console_error", t.slice(0, 200));
});

let failed = 0;
const check = (name, cond, extra) => {
  if (cond) console.log("PASS", name);
  else {
    failed += 1;
    console.log("FAIL", name, extra || "");
  }
};

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector("[data-simple-card]", { timeout: 30000 });
  const cards = page.locator("[data-simple-card]");
  check("three cards", (await cards.count()) === 3, await cards.count());
  check("no coming soon at start", !(await page.getByText("Coming soon").count()));
  check("no unlock screen", await page.locator("#unlockScreen").isHidden());

  const monday = page.locator('[data-simple-card="001"]');
  const before = await readBoard(page);
  const beforeHead = postHeadline(before, "001");
  const beforePhoto = before["001"]?.photo || before["001"]?.customPhoto;
  check("monday has copy", !!beforeHead, beforeHead);

  await monday.locator('[data-simple="regen"]').click();
  await page.waitForFunction((prev) => {
    try {
      const st = JSON.parse(localStorage.getItem("oar-jon-board-v27") || "{}");
      const p = st["001"] || {};
      const head = `${p.line1 || ""} ${p.line2 || ""}`.replace(/\s+/g, " ").trim();
      return head && head !== prev;
    } catch { return false; }
  }, beforeHead, { timeout: 60000 });

  const afterRegen = await readBoard(page);
  const afterHead = postHeadline(afterRegen, "001");
  const afterPhotoSame = (afterRegen["001"]?.photo || afterRegen["001"]?.customPhoto) === beforePhoto;
  check("try another changed copy", afterHead !== beforeHead, `${beforeHead} -> ${afterHead}`);
  check("try another kept photo", afterPhotoSame, `${beforePhoto}`);
  check("try another no coming soon", !(await monday.getByText("Coming soon").count()));

  await monday.screenshot({ path: path.join(OUT, "regen-card-390x844.png") });
  await page.screenshot({ path: path.join(OUT, "simple-view-after-regen-390x844.png"), fullPage: false });
  console.log("screenshot_saved");

  const photoBefore = afterRegen["001"]?.photo || afterRegen["001"]?.customPhoto;
  await monday.locator('[data-simple="photo"]').click();
  await page.waitForFunction((prev) => {
    try {
      const st = JSON.parse(localStorage.getItem("oar-jon-board-v27") || "{}");
      const p = st["001"] || {};
      const photo = p.customPhoto || p.photo || "";
      const msg = document.querySelector('[data-simple-card="001"] [data-simple-msg]')?.textContent || "";
      return photo && photo !== prev && !/coming soon/i.test(msg);
    } catch { return false; }
  }, photoBefore, { timeout: 60000 });
  const afterPhoto = await readBoard(page);
  const photoAfter = afterPhoto["001"]?.photo || afterPhoto["001"]?.customPhoto;
  check("change photo swapped photo", photoAfter && photoAfter !== photoBefore, `${photoBefore} -> ${photoAfter}`);
  check("change photo no coming soon", !(await monday.getByText("Coming soon").count()));

  await page.locator("#btnAddJobPhoto").click();
  await page.waitForSelector("#simpleJobSheet:not([hidden])", { timeout: 10000 });
  await page.locator("#simpleJobNote").fill("JONBOT-TEST-NOTE: grey roller test only.");
  await page.locator("#simpleJobUpload").setInputFiles(path.join(ROOT, "photos/stock-001.jpg"));
  await page.waitForFunction(() => !document.querySelector("#simpleJobSend")?.disabled, null, { timeout: 30000 });
  await page.locator("#simpleJobSend").click();
  await page.waitForSelector("#simpleThanks:not([hidden])", { timeout: 20000 });
  check("thanks shown after note", true);

  // Give the POST a moment, then confirm the inbox has the unused note
  await page.waitForTimeout(1500);
  const notes = await api("GET", "/notes");
  const list = notes.data?.notes || [];
  const found = list.some((n) => String(n.text || "").includes("JONBOT-TEST-NOTE") && !n.usedAt);
  check("note reached POST /notes", notes.status === 200 && found, `status=${notes.status} count=${list.length}`);
} catch (err) {
  failed += 1;
  console.log("FAIL uncaught", String(err && err.message || err).slice(0, 400));
  try { await page.screenshot({ path: path.join(OUT, "failure-390x844.png") }); } catch {}
} finally {
  await browser.close();
  server.close();
}

process.exit(failed ? 1 : 0);
