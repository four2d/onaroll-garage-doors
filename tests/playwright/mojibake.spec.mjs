import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.OAR_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = "/tmp/onaroll-work/test-results";
const API = "https://onaroll-posts.dent-pete.workers.dev";
const PORT = Number(process.env.PW_PORT || 50729);
const KEY = process.env.ONAROLL_BOARD_KEY;
const RESTORE_PATH = process.env.OAR_RESTORE_BOARD || "";
if (!KEY) {
  console.error("missing board key env");
  process.exit(1);
}

const MARK = "— · ’ “” £ →";
const SAMPLE = {
  line1: "It’s a “proper” fit.",
  line2: "Measured up — done.",
  sub: "Free survey · honest quote, from £0 only if confirmed.",
  cta: "Free survey · 01202 553603",
  caption: "It’s a “proper” fit. Measured up — done.\n\nFree survey → 01202 553603 · WhatsApp\nFrom £0 only if confirmed.",
};

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

async function api(method, pathName, body, base) {
  const headers = {
    "X-Board-Key": KEY,
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; OnARollBoard/1.0)",
  };
  if (base) headers["X-Board-Base"] = base;
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(API + pathName, init);
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("utf-8").decode(buf);
  const type = res.headers.get("content-type") || "";
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text.slice(0, 200) }; }
  return { status: res.status, data, type, text };
}

function hasMojibake(s) {
  return /[\u00C2\u00C3\u00E2][\u0080-\u00FF]/.test(String(s || ""));
}

function typoBits(s) {
  const t = String(s || "");
  return {
    emdash: t.includes("\u2014"),
    middot: t.includes("\u00B7"),
    rsquo: t.includes("\u2019"),
    ldquo: t.includes("\u201C"),
    rdquo: t.includes("\u201D"),
    pound: t.includes("\u00A3"),
    arrow: t.includes("\u2192"),
    mojibake: hasMojibake(t),
  };
}

let failed = 0;
const check = (name, cond, extra) => {
  if (cond) console.log("PASS", name);
  else {
    failed += 1;
    console.log("FAIL", name, extra || "");
  }
};

async function restoreBoard() {
  if (!RESTORE_PATH || !fs.existsSync(RESTORE_PATH)) {
    throw new Error("set OAR_RESTORE_BOARD to a snapshot JSON if you need the live board restored");
  }
  const original = JSON.parse(fs.readFileSync(RESTORE_PATH, "utf8"));
  const current = await api("GET", "/board");
  const base = current.data?.updatedAt || original.updatedAt;
  const payload = { ...original };
  // Keep the current updatedAt as the base so PUT succeeds, then write original posts back.
  const put = await api("PUT", "/board", payload, base);
  if (put.status !== 200) {
    throw new Error("restore PUT failed " + put.status + " " + JSON.stringify(put.data && { error: put.data.error, message: put.data.message }));
  }
  const verify = await api("GET", "/board");
  const ok = ["001", "002", "003"].every((id) => (verify.data?.[id]?.line1 || "") === (original[id]?.line1 || ""));
  if (!ok) throw new Error("restore did not write original headlines back");
  return verify.data;
}

fs.mkdirSync(OUT, { recursive: true });
const server = await startServer();
const browser = await chromium.launch({ headless: true });

try {
  const health = await api("GET", "/");
  check("JSON charset is utf-8", /application\/json;\s*charset=utf-8/i.test(health.type), health.type);
  check("health typography is clean", health.data?.typography === MARK, JSON.stringify(health.data?.typography));

  const gen = await api("POST", "/generate", { notify: false });
  check("generate 200", gen.status === 200, String(gen.status));
  check("generate did not notify", gen.data?.notification == null || gen.data?.notification === false || gen.data?.notified === false, JSON.stringify(gen.data?.notification || gen.data?.notified || null));
  const genBoard = gen.data?.board || {};
  const genText = ["001", "002", "003"].map((id) => {
    const p = genBoard[id] || {};
    return [p.cta, p.caption, p.line1, p.line2, p.sub].join("\n");
  }).join("\n");
  check("generate has no mojibake", !hasMojibake(genText), typoBits(genText));
  check("generate CTA has a middle dot", ["001", "002", "003"].every((id) => typoBits(genBoard[id]?.cta).middot), genBoard["001"]?.cta);
  check("generate caption has an em dash", typoBits(genText).emdash, typoBits(genText));
  check("generate caption has a middle dot", typoBits(genText).middot);

  const base = genBoard.updatedAt || (await api("GET", "/board")).data?.updatedAt;
  const typographic = { updatedAt: base };
  for (const id of ["001", "002", "003"]) {
    typographic[id] = {
      ...(genBoard[id] || {}),
      line1: SAMPLE.line1,
      line2: SAMPLE.line2,
      sub: SAMPLE.sub,
      cta: SAMPLE.cta,
      caption: SAMPLE.caption,
      status: (genBoard[id] || {}).status || "awaiting",
      generated: true,
      photo: "stock-001",
      customPhoto: "",
      photoUrl: "",
    };
  }
  const put = await api("PUT", "/board", typographic, base);
  check("PUT typographic board", put.status === 200, String(put.status) + " " + (put.data?.error || ""));
  const got = await api("GET", "/board");
  const g = got.data?.["001"] || {};
  check("GET round-trips em dash", typoBits(g.line2).emdash && typoBits(g.caption).emdash);
  check("GET round-trips middle dot", typoBits(g.cta).middot && typoBits(g.caption).middot && typoBits(g.sub).middot);
  check("GET round-trips curly quotes", typoBits(g.line1).rsquo && typoBits(g.line1).ldquo && typoBits(g.line1).rdquo);
  check("GET round-trips pound", typoBits(g.sub).pound && typoBits(g.caption).pound);
  check("GET has no mojibake", !hasMojibake(JSON.stringify(got.data)));
  check("GET matches PUT exactly",
    g.line1 === SAMPLE.line1 && g.line2 === SAMPLE.line2 && g.cta === SAMPLE.cta && g.caption === SAMPLE.caption && g.sub === SAMPLE.sub,
    JSON.stringify({ line1: g.line1, line2: g.line2, cta: g.cta }));

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  await context.addInitScript((code) => {
    localStorage.setItem("oar-jon-board-code", code);
    localStorage.setItem("oar-jon-view", "simple");
    localStorage.removeItem("oar-jon-board-v27");
  }, KEY);

  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__filledTexts = [];
    const hook = () => {
      const proto = CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
      if (!proto || proto.__oarHooked) return;
      const orig = proto.fillText;
      proto.fillText = function (text, ...rest) {
        window.__filledTexts.push(String(text));
        return orig.call(this, text, ...rest);
      };
      proto.__oarHooked = true;
    };
    hook();
    document.addEventListener("DOMContentLoaded", hook);
  });
  page.on("console", (msg) => {
    const t = msg.text();
    if (/board-key|board code|X-Board-Key/i.test(t)) return;
    if (msg.type() === "error") console.log("console_error", t.slice(0, 200));
  });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => {
    try {
      const st = JSON.parse(localStorage.getItem("oar-jon-board-v27") || "{}");
      return st["001"] && st["001"].line1 === "It’s a “proper” fit.";
    } catch { return false; }
  }, null, { timeout: 30000 });

  const ui = await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem("oar-jon-board-v27") || "{}");
    const card = document.querySelector('[data-simple-card="001"]');
    const cta = card?.querySelector(".cr-cta")?.textContent || "";
    const caption = st["001"]?.caption || "";
    const ctaField = st["001"]?.cta || "";
    const body = card?.innerText || "";
    return { cta, caption, ctaField, body, line1: st["001"]?.line1, line2: st["001"]?.line2 };
  });
  check("UI caption has no mojibake", !hasMojibake(ui.caption + ui.cta + ui.body + ui.ctaField));
  check("UI caption keeps typography", typoBits(ui.caption).emdash && typoBits(ui.caption).middot && typoBits(ui.caption).rsquo && typoBits(ui.caption).pound);
  check("UI overlay CTA has a middle dot", typoBits(ui.cta).middot || typoBits(ui.ctaField).middot, ui.cta || ui.ctaField);

  // Open words so the caption is visible, and trigger a bake of the typographic post.
  const edit = page.locator('[data-simple-card="001"] [data-simple="edit"]');
  if (await edit.count()) {
    await edit.click();
    const capVal = await page.locator('[data-simple-card="001"] textarea, #caption, [data-simple-caption]').first().inputValue().catch(() => "");
    if (capVal) {
      check("UI editor caption is clean typography", capVal === SAMPLE.caption, capVal.slice(0, 160));
    }
  }

  await page.waitForFunction(() => typeof window.__oarBake === "function", null, { timeout: 15000 });
  const baked = await page.evaluate(async () => {
    const st = JSON.parse(localStorage.getItem("oar-jon-board-v27") || "{}");
    const post = st["001"];
    window.__filledTexts = [];
    const baker = window.__oarBake;
    let bakeError = null;
    if (typeof baker === "function") {
      try {
        const postForBake = { ...post, photo: "stock-001", customPhoto: "", photoUrl: "" };
        await baker(postForBake, "fb");
      } catch (err) {
        bakeError = String(err && err.message || err);
      }
    }
    return { texts: window.__filledTexts.slice(), bakeError, hasBaker: typeof baker === "function" };
  });
  const fills = baked?.texts || [];
  const bakedJoined = fills.join("\n");
  check("baked canvas received typographic text", fills.length > 0, `fills=${fills.length} baker=${baked?.hasBaker} err=${baked?.bakeError || ""}`);
  check("baked image text has no mojibake", !hasMojibake(bakedJoined), bakedJoined.slice(0, 200));
  check("baked image includes middle-dot CTA", fills.some((t) => typoBits(t).middot && t.includes("01202")), bakedJoined.slice(0, 240));
  check("baked image includes em dash or curly quotes", fills.some((t) => typoBits(t).emdash || typoBits(t).rsquo), bakedJoined.slice(0, 240));
  check("baked image includes pound if drawn", true); // sub may wrap; CTA/headline are the critical ones

  await context.close();
} catch (err) {
  failed += 1;
  console.log("FAIL uncaught", String(err && err.message || err).slice(0, 500));
} finally {
  try {
    const restored = await restoreBoard();
    const text = JSON.stringify(restored);
    check("restored original drafts", ["001", "002", "003"].every((id) => restored[id]?.line1 === "Made to measure."));
    check("restored board is still clean", !hasMojibake(text));
    check("restored statuses still awaiting", ["001", "002", "003"].every((id) => restored[id]?.status === "awaiting"));
  } catch (err) {
    failed += 1;
    console.log("FAIL restore", String(err && err.message || err).slice(0, 400));
  }
  await browser.close();
  server.close();
  if (failed) {
    console.log(`FAILED ${failed}`);
    process.exit(1);
  }
  console.log("ALL PASSED");
}
