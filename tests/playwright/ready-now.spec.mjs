import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.OAR_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = "/tmp/onaroll-work/test-results";
const API = "https://onaroll-posts.dent-pete.workers.dev";
const PORT = Number(process.env.PW_PORT || 34239);
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

async function api(method, pathName, body, base) {
  const headers = {
    "X-Board-Key": KEY,
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; OnARollBoard/1.0)",
  };
  if (base) headers["X-Board-Base"] = base;
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

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function ensureDrafts(tries = 8) {
  for (let i = 0; i < tries; i++) {
    const res = await api("POST", "/ensure-drafts");
    if (res.status === 202 || res.data?.pending) {
      await sleep(1500);
      continue;
    }
    return res;
  }
  throw new Error("ensure-drafts stayed pending");
}

async function approveAndSchedule() {
  const got = await api("GET", "/board");
  const board = got.data || {};
  for (const id of ["001", "002", "003"]) {
    if (!board[id]) throw new Error("missing draft " + id);
    board[id].status = "approved";
  }
  const put = await api("PUT", "/board", board, board.updatedAt);
  if (put.status !== 200) throw new Error("PUT board failed " + put.status);
  const sched = await api("POST", "/schedule");
  if (sched.status !== 200 || !sched.data?.ok) {
    throw new Error("schedule failed " + JSON.stringify({ status: sched.status, error: sched.data?.error }));
  }
  return sched.data;
}

function headlines(state) {
  return ["001", "002", "003"].map((id) => {
    const p = state?.[id] || {};
    return `${p.line1 || ""} ${p.line2 || ""}`.replace(/\s+/g, " ").trim();
  });
}

async function readBoard(page) {
  return page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("oar-jon-board-v27") || "{}"); }
    catch { return {}; }
  });
}

async function waitForThreePosts(page, timeout = 90000) {
  await page.waitForFunction(() => {
    const cards = document.querySelectorAll("[data-simple-card]");
    if (cards.length !== 3) return false;
    try {
      const st = JSON.parse(localStorage.getItem("oar-jon-board-v27") || "{}");
      return ["001", "002", "003"].every((id) => st[id] && String(st[id].line1 || "").trim());
    } catch { return false; }
  }, null, { timeout });
}

fs.mkdirSync(OUT, { recursive: true });
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

const scheduled = [];

try {
  const clearedBoard = await api("DELETE", "/board");
  const clearedSched = await api("DELETE", "/schedule");
  check("pretest cleared board", clearedBoard.status === 200 && clearedBoard.data?.ok);
  check("pretest cleared schedule", clearedSched.status === 200 && Array.isArray(clearedSched.data?.weeks));

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
  check("no sunday-evening copy", !(await page.getByText("Sunday evening").count()));
  check("no unlock screen", await page.locator("#unlockScreen").isHidden());

  // Overlay should appear while the first set is written (may already be in flight).
  const busySeen = await page.locator("#simplePageBusy").isVisible().catch(() => false);
  await waitForThreePosts(page);
  const busyGone = await page.locator("#simplePageBusy").isHidden();
  check("load generated three posts", (await page.locator("[data-simple-card]").count()) === 3);
  check("page busy hidden after generate", busyGone, `busySeen=${busySeen}`);

  const first = headlines(await readBoard(page));
  check("first set has headlines", first.every(Boolean), first.join(" | "));
  const firstState = await readBoard(page);
  const previewLabels = ["001", "002", "003"].map((id) => firstState[id]?.scheduledLabel);
  check("drafts preview next empty week", previewLabels.join("|") === "Mon 23 Nov|Wed 25 Nov|Fri 27 Nov", previewLabels.join("|"));

  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForThreePosts(page);
  const afterReload = headlines(await readBoard(page));
  check("reload did not duplicate cards", (await page.locator("[data-simple-card]").count()) === 3);
  check("reload kept the same set", afterReload.join("\n") === first.join("\n"), afterReload.join(" | "));

  for (const id of ["001", "002", "003"]) {
    const card = page.locator(`[data-simple-card="${id}"]`);
    await card.locator('[data-simple="approve"]').click();
  }
  await page.waitForFunction(() => {
    const text = Array.from(document.querySelectorAll("[data-simple-card] .s-when, [data-simple-card] [data-simple-msg], [data-simple-card] p"))
      .map((el) => el.textContent || "")
      .join(" ");
    return /Scheduled for Mon 23 Nov/.test(text) && /Scheduled for Wed 25 Nov/.test(text) && /Scheduled for Fri 27 Nov/.test(text);
  }, null, { timeout: 30000 });

  const body = await page.locator("#simpleStack").innerText();
  check("scheduled Mon 23 Nov", /Scheduled for Mon 23 Nov/.test(body), body.slice(0, 400));
  check("scheduled Wed 25 Nov", /Scheduled for Wed 25 Nov/.test(body));
  check("scheduled Fri 27 Nov", /Scheduled for Fri 27 Nov/.test(body));
  scheduled.push({
    weekId: "2026-11-23",
    dates: ["2026-11-23", "2026-11-25", "2026-11-27"],
    labels: ["Mon 23 Nov", "Wed 25 Nov", "Fri 27 Nov"],
    via: "ui",
  });

  const sched = await api("GET", "/schedule");
  const weekIds = (sched.data?.weeks || []).map((w) => w.weekId);
  check("schedule has week of 23 Nov", weekIds.includes("2026-11-23"), weekIds.join(","));

  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForThreePosts(page, 120000);
  const second = headlines(await readBoard(page));
  check("next load made a fresh set", second.every(Boolean) && second.join("\n") !== first.join("\n"), second.join(" | "));
  const secondState = await readBoard(page);
  const secondLabels = ["001", "002", "003"].map((id) => secondState[id]?.scheduledLabel);
  check("fresh set is week of 30 Nov", secondLabels.join("|") === "Mon 30 Nov|Wed 2 Dec|Fri 4 Dec", secondLabels.join("|"));
  check("advanced editor link still present", await page.getByText("Advanced editor").count() > 0);

  // Fill the rest of the 4-week cap via the API so we do not wait on more UI generates.
  const week2 = await approveAndSchedule();
  scheduled.push({
    weekId: week2.weekId,
    dates: ["001", "002", "003"].map((id) => week2.posts?.[id]?.scheduledFor || week2.week?.[id]?.scheduledFor),
    labels: ["001", "002", "003"].map((id) => week2.posts?.[id]?.scheduledLabel || week2.week?.[id]?.scheduledLabel),
    via: "api",
  });
  for (let i = 0; i < 2; i++) {
    const ens = await ensureDrafts();
    check(`cap week ${i + 3} generated`, !!(ens.data?.board?.["001"]?.line1), ens.data?.reason);
    const week = await approveAndSchedule();
    scheduled.push({
      weekId: week.weekId,
      dates: ["001", "002", "003"].map((id) => week.posts?.[id]?.scheduledFor || week.week?.[id]?.scheduledFor),
      labels: ["001", "002", "003"].map((id) => week.posts?.[id]?.scheduledLabel || week.week?.[id]?.scheduledLabel),
      via: "api",
    });
  }

  const cap = await ensureDrafts();
  check("ensure reports queue full", cap.data?.queueFull === true && cap.data?.reason === "queue-full", cap.data?.reason);
  check("sorted until Fri 18 Dec (api)", cap.data?.schedule?.sortedUntil === "Fri 18 Dec", cap.data?.schedule?.sortedUntil);

  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => {
    const el = document.getElementById("simpleEmptyText") || document.getElementById("simpleEmpty");
    return /You're sorted until Fri 18 Dec/.test(el?.textContent || document.body.innerText || "");
  }, null, { timeout: 30000 });
  const emptyText = (await page.locator("#simpleEmptyText").textContent().catch(() => "")) || "";
  check("UI shows sorted until Fri 18 Dec", /You're sorted until Fri 18 Dec/.test(emptyText), emptyText);
  check("no draft cards when queue is full", (await page.locator("[data-simple-card]").count()) === 0);
} catch (err) {
  failed += 1;
  console.log("FAIL uncaught", String(err && err.message || err).slice(0, 500));
  try { await page.screenshot({ path: path.join(OUT, "ready-now-failure-390x844.png") }); } catch {}
} finally {
  try {
    const b = await api("DELETE", "/board");
    const s = await api("DELETE", "/schedule");
    check("cleared board after tests", b.status === 200 && b.data?.ok);
    check("cleared schedule after tests", s.status === 200 && Array.isArray(s.data?.weeks) && s.data.weeks.length === 0);
  } catch (err) {
    failed += 1;
    console.log("FAIL cleanup", String(err && err.message || err).slice(0, 200));
  }
  console.log("SCHEDULED_SETS", JSON.stringify(scheduled, null, 2));
  await browser.close();
  server.close();
  if (failed) {
    console.log(`FAILED ${failed}`);
    process.exit(1);
  }
  console.log("ALL PASSED");
}
