import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = process.env.OAR_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API = "https://onaroll-posts.dent-pete.workers.dev";
const PORT = Number(process.env.PW_PORT || 56625);
const KEY = process.env.ONAROLL_BOARD_KEY;
const HOOK = process.env.ONAROLL_AUTH_TEST_HOOK;
const EMAIL = "dent.pete@gmail.com";
const PHONE_RAW = "07854 046904";
const BEFORE = process.env.OAR_SNAPSHOT_BOARD || "";
if (!KEY || !HOOK) {
  console.error("missing test env");
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

async function api(method, pathName, body, headers = {}) {
  const h = {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; OnARollBoard/1.0)",
    ...headers,
  };
  const init = { method, headers: h };
  if (body !== undefined) {
    h["Content-Type"] = "application/json; charset=utf-8";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(API + pathName, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

function sha(s) {
  return createHash("sha256").update(String(s)).digest("hex");
}

let failed = 0;
const check = (name, cond, extra) => {
  if (cond) console.log("PASS", name);
  else {
    failed += 1;
    console.log("FAIL", name, extra || "");
  }
};

const server = await startServer();
const browser = await chromium.launch({ headless: true });
let before = {};
if (BEFORE && fs.existsSync(BEFORE)) before = JSON.parse(fs.readFileSync(BEFORE, "utf8"));


try {
  if (!before["001"]) {
    const snap = await api("GET", "/board", undefined, { "X-Board-Key": KEY });
    if (snap.status === 200) before = snap.data || {};
  }
  const unknown = await api("POST", "/auth/request", { contact: "not-registered@example.com" }, { "X-Auth-Test": HOOK });
  check("unknown contact is generic 200", unknown.status === 200 && unknown.data?.ok === true);
  check("unknown contact uses generic copy", /if that's registered, a code is on its way/i.test(unknown.data?.message || ""));
  check("unknown contact has no dev code", !unknown.data?.devCode && !unknown.data?.devLogin);
  check("unknown contact did not mark a real send", unknown.data?.test !== true || !unknown.data?.devCode);

  const phone = await api("POST", "/auth/request", { contact: PHONE_RAW }, { "X-Auth-Test": HOOK });
  check("UK 07 number is accepted", phone.status === 200 && phone.data?.ok === true);
  check("normalized phone issued a test code", phone.data?.test === true && String(phone.data?.devCode || "").length === 6);

  const bad = await api("POST", "/auth/verify", { contact: EMAIL, code: "000000" });
  check("wrong code is rejected", bad.status === 401);

  const requested = await api("POST", "/auth/request", { contact: EMAIL }, { "X-Auth-Test": HOOK });
  check("email request is test-skipped", requested.data?.test === true && String(requested.data?.devCode || "").length === 6);
  const emailCode = requested.data.devCode;
  const emailLogin = requested.data.devLogin;
  const verified = await api("POST", "/auth/verify", { contact: EMAIL, code: emailCode });
  check("verify returns a session, not a board key", verified.status === 200 && !!verified.data?.session);
  check("session is not the board key", sha(verified.data?.session || "") !== sha(KEY));
  check("verify response has no board key field", !("boardKey" in (verified.data || {})) && !("BOARD_KEY" in (verified.data || {})));
  const board = await api("GET", "/board", undefined, { "X-Board-Key": verified.data.session });
  check("session can read the board", board.status === 200 && board.data?.["001"]?.line1 === before["001"]?.line1);
  const reused = await api("POST", "/auth/verify", { contact: EMAIL, code: emailCode });
  check("code is single use", reused.status === 401);

  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  let uiCode = null;
  let sentReal = false;
  await ctx.route("**/auth/request", async (route) => {
    const headers = { ...route.request().headers(), "X-Auth-Test": HOOK };
    const res = await route.fetch({ headers });
    const data = await res.json().catch(() => ({}));
    if (data.devCode) uiCode = data.devCode;
    if (data.test !== true) sentReal = true;
    const safe = { ...data };
    delete safe.devCode;
    delete safe.devLogin;
    await route.fulfill({
      status: res.status(),
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(safe),
    });
  });
  const page = await ctx.newPage();
  page.on("console", (msg) => {
    const t = msg.text();
    if (/board-key|board code|X-Board-Key|session|devCode|devLogin/i.test(t)) return;
    if (msg.type() === "error") console.log("console_error", t.slice(0, 200));
  });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("#unlockScreen", { timeout: 10000 });
  const lead = await page.locator("#unlockLead").textContent();
  check("lock screen asks for number or email", /mobile number or email/i.test(lead || ""));
  check("send button is present", await page.getByRole("button", { name: "Send me a code" }).count() > 0);
  check("board-code fallback link is present", await page.getByRole("button", { name: "Have a board code?" }).count() > 0);

  await page.locator("#unlockContact").fill(EMAIL);
  await page.getByRole("button", { name: "Send me a code" }).click();
  await page.waitForSelector("#unlockCodeStep:not([hidden])", { timeout: 15000 });
  const sentMsg = await page.locator("#unlockStatus").textContent();
  check("UI shows generic sent copy", /if that's registered, a code is on its way/i.test(sentMsg || ""));
  check("UI request used the test hook (no real send)", !sentReal && String(uiCode || "").length === 6);

  await page.locator("#unlockCode").fill(uiCode);
  await page.getByRole("button", { name: "Open the board" }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains("is-unlocked"), null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const cards = document.querySelectorAll("[data-simple-card]");
    const empty = document.getElementById("simpleEmpty");
    return cards.length === 3 || (empty && !empty.hidden);
  }, null, { timeout: 60000 });
  const auth = await page.evaluate(() => ({
    sessionLen: (localStorage.getItem("oar-jon-session") || "").length,
    hasBoardCode: !!localStorage.getItem("oar-jon-board-code"),
    unlocked: document.documentElement.classList.contains("is-unlocked"),
    cards: document.querySelectorAll("[data-simple-card]").length,
  }));
  check("UI stored a session token", auth.sessionLen >= 32, `len=${auth.sessionLen}`);
  check("UI did not store a raw board key from login", auth.hasBoardCode === false);
  check("simple view loaded after code login", auth.unlocked && (auth.cards === 3 || auth.cards === 0));

  const session = await page.evaluate(() => localStorage.getItem("oar-jon-session") || "");
  check("stored session is not the board key", sha(session) !== sha(KEY));

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => document.documentElement.classList.contains("is-unlocked"), null, { timeout: 15000 });
  check("reload stays signed in", await page.locator("#unlockScreen").isHidden());

  await ctx.close();

  // Magic link in a fresh browser, as if opening from email in any browser
  const relogin = await api("POST", "/auth/request", { contact: EMAIL }, { "X-Auth-Test": HOOK });
  check("fresh magic login ticket issued", relogin.data?.test === true && String(relogin.data?.devLogin || "").length >= 32);
  const magicCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const magicPage = await magicCtx.newPage();
  await magicPage.goto(`http://127.0.0.1:${PORT}/index.html#login=${relogin.data.devLogin}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await magicPage.waitForFunction(() => document.documentElement.classList.contains("is-unlocked"), null, { timeout: 30000 });
  const magicAuth = await magicPage.evaluate(() => ({
    sessionLen: (localStorage.getItem("oar-jon-session") || "").length,
    hasBoardCode: !!localStorage.getItem("oar-jon-board-code"),
    hash: location.hash,
  }));
  check("magic link signed in without a board code", magicAuth.sessionLen >= 32 && magicAuth.hasBoardCode === false);
  check("magic link was stripped from the URL", magicAuth.hash === "");
  await magicCtx.close();

  // Board-code fallback still works
  const fallbackCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const fallbackPage = await fallbackCtx.newPage();
  await fallbackPage.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await fallbackPage.getByRole("button", { name: "Have a board code?" }).click();
  await fallbackPage.waitForSelector("#unlockBoardStep:not([hidden])", { timeout: 5000 });
  await fallbackPage.locator("#boardCode").fill(KEY);
  await fallbackPage.getByRole("button", { name: "Open the board" }).click();
  await fallbackPage.waitForFunction(() => document.documentElement.classList.contains("is-unlocked"), null, { timeout: 30000 });
  check("board-code fallback still unlocks", true);
  await fallbackCtx.close();
} catch (err) {
  failed += 1;
  console.log("FAIL uncaught", String(err && err.message || err).slice(0, 500));
} finally {
  try {
    const after = await api("GET", "/board", undefined, { "X-Board-Key": KEY });
    const same = ["001", "002", "003"].every((id) =>
      (after.data?.[id]?.line1 || "") === (before[id]?.line1 || "") &&
      (after.data?.[id]?.status || "") === (before[id]?.status || "")
    );
    check("live drafts and approvals are unchanged", after.status === 200 && same, JSON.stringify({
      statuses: { "001": after.data?.["001"]?.status, "002": after.data?.["002"]?.status, "003": after.data?.["003"]?.status },
    }));
  } catch (err) {
    failed += 1;
    console.log("FAIL board check", String(err && err.message || err).slice(0, 200));
  }
  await browser.close();
  server.close();
  if (failed) {
    console.log(`FAILED ${failed}`);
    process.exit(1);
  }
  console.log("ALL PASSED");
}
