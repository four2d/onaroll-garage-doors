/**
 * On a Roll social board — sync, photo library, and week archive.
 *
 * Storage: Workers KV (R2 is not enabled on this account). Photos are stored
 * as binary values, capped well under the KV value limit. The client should
 * compress uploads (the existing board already resizes to JPEG) before POST.
 *
 * Weekly drafts are built by the Sunday 18:00 UTC cron and POST /generate,
 * using Workers AI with template fallback, then notify() emails NOTIFY_EMAILS
 * and WhatsApp via CallMeBot if CALLMEBOT_APIKEY is set.
 *
 * Future Meta publishing (do not implement here) will read:
 *   env.META_PAGE_TOKEN, env.META_PAGE_ID, env.META_IG_USER_ID
 * Instagram Graph publishing requires a public HTTPS image URL, which
 * GET /photos/:id already provides.
 */

const ALLOWED_ORIGINS = new Set([
  "https://four2d.github.io",
  "http://localhost",
  "http://127.0.0.1",
]);

const MAX_PHOTO_BYTES = 4 * 1024 * 1024; // 4 MiB — well under the 25 MiB KV value limit
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const WEEK_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

const BOARD_KEY = "board:current";
const PHOTO_DATA = (id) => `photo:data:${id}`;
const PHOTO_META = (id) => `photo:meta:${id}`;
const PHOTO_INDEX = "photo:index";
const ARCHIVE_DATA = (id) => `archive:data:${id}`;
const ARCHIVE_INDEX = "archive:index";
const PHOTO_USED = "photo:used";
const NOTIFY_STATE = "notify:latest";
const MANIFEST_URL = "https://four2d.github.io/onaroll-garage-doors/photos/manifest.json";
const DEFAULT_BOARD_URL = "https://four2d.github.io/onaroll-garage-doors/";
const DEFAULT_FROM = "onaroll-posts@foxonsoftware.com";
const DEFAULT_CTA = "Free survey · 01202 553603";
const DEFAULT_PRICE_FROM = "From";
const PHONE = "01202 553603";
const WHATSAPP_DISPLAY = "07534 066813";
const BRAND_SIGN_OFF = "On A Roll Garage Doors — Family-run, local garage door fitters in Poole.";
const CRON_GENERATE = "0 18 * * SUN";
const CRON_REMIND = "0 8 * * MON,WED,FRI";
const CRON_PUBLISH = "0 12 * * MON,WED,FRI";
const CRON_NUDGE = "0 17 * * THU";
const HISTORY_KEY = "history:weeks";
const NOTES_KEY = "notes:inbox";
const NUDGE_KEY = "nudge:latest";
const SCHEDULE_KEY = "schedule:weeks";
const DRAFT_LOCK_KEY = "draft:lock";
const AUTH_OTP_PREFIX = "auth:otp:";
const AUTH_LOGIN_PREFIX = "auth:login:";
const AUTH_SESSION_PREFIX = "auth:session:";
const AUTH_RL_CONTACT_PREFIX = "auth:rl:contact:";
const AUTH_RL_IP_PREFIX = "auth:rl:ip:";
const AUTH_LAST_DELIVERY = "auth:last-delivery";
const AUTH_CODE_TTL_SEC = 10 * 60;
const AUTH_SESSION_TTL_SEC = 180 * 24 * 60 * 60;
const AUTH_RL_CONTACT_LIMIT = 3;
const AUTH_RL_CONTACT_TTL_SEC = 15 * 60;
const AUTH_RL_IP_LIMIT = 10;
const AUTH_RL_IP_TTL_SEC = 60 * 60;
const AUTH_MAX_ATTEMPTS = 5;
const HISTORY_WEEKS = 8;
const QUEUE_WEEKS = 4;
const DRAFT_LOCK_MS = 90 * 1000;
const LOW_UPLOAD_THRESHOLD = 3;
const NOTE_MAX = 2000;
const ASK_DAYS = 14;
const LOCAL_TOWNS = ["Poole", "Bournemouth", "Christchurch", "Wimborne", "Ferndown", "Broadstone", "Wareham", "Swanage"];
const PHOTO_ASK = "Running low on fresh photos – snap a couple from this week's jobs and add them here:";
const PHOTO_NUDGE = "If you've had a couple of jobs this week, a few photos would keep the posts fresh – add them here:";
const LINE_MAX = 42;
const SUB_MAX = 110;
const CAPTION_MAX = 2200;
const AI_MODELS = [
  "@cf/zai-org/glm-4.7-flash",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
];
const SLOTS = [
  { id: "001", day: "Monday" },
  { id: "002", day: "Wednesday" },
  { id: "003", day: "Friday" },
];
const ANGLE_DEFS = [
  { id: "recent-install", group: "install", label: "a recent install — a real job just finished, tidy and local" },
  { id: "before-after", group: "install", label: "a before-and-after — old door out, new roller in" },
  { id: "security", group: "benefit", label: "a security benefit of a modern roller door" },
  { id: "insulation", group: "benefit", label: "insulation or quiet operation — warmer, quieter, fewer draughts" },
  { id: "seasonal-dark", group: "seasonal", months: [10, 11, 12, 1], label: "darker evenings — a garage that's easy and safe to get into after dark" },
  { id: "seasonal-winter", group: "seasonal", months: [12, 1, 2], label: "winter cold — a well-insulated roller helping keep the garage warmer" },
  { id: "seasonal-spring", group: "seasonal", months: [3, 4, 5], label: "a spring tidy-up — a good time to replace a tired garage door" },
  { id: "seasonal-summer", group: "seasonal", months: [6, 7, 8], label: "summer garage use — a door that's easy to live with in warmer weather" },
  { id: "local", group: "local" },
  { id: "family-run", group: "business", label: "behind the scenes or family-run — the local team, honest and unshowy" },
  { id: "free-survey", group: "cta", label: "how a free survey works — we come out, measure up, talk it through, no hard sell" },
  { id: "maintenance", group: "tips", label: "a simple maintenance tip: help people spot the signs of a tired door, then call us. Never tell anyone to touch, tug, tighten or adjust springs, cables or tension" },
  { id: "colours", group: "product", label: "choosing colours and finishes for a made-to-measure roller" },
];
const HASHTAGS = {
  "001": "#OnARollGarageDoors #GarageDoors #RollerGarageDoor #Poole #Bournemouth #Christchurch #Dorset #FreeSurvey #FamilyRun",
  "002": "#GarageDoorSecurity #HomeSecurity #Poole #Bournemouth #Christchurch #Dorset #OnARollGarageDoors",
  "003": "#FreeSurvey #GarageDoorFitters #Poole #Bournemouth #Christchurch #Dorset #OnARollGarageDoors #FamilyRun",
};

export default {
  async fetch(request, env) {
    try {
      const origin = corsOrigin(request);
      if (request.method === "OPTIONS") {
        return corsPreflight(origin);
      }

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const response = await route(request, env, path);
      return withCors(response, origin);
    } catch (err) {
      const message = err && err.message ? err.message : "internal error";
      const status = err && err.status ? err.status : 500;
      return withCors(json(status, { error: message }), corsOrigin(request));
    }
  },

  async scheduled(controller, env, ctx) {
    const cron = controller.cron;
    const when = new Date(controller.scheduledTime || Date.now());
    if (cron === CRON_GENERATE) {
      await sundayEnsureDrafts(env, when);
      return;
    }
    if (cron === CRON_REMIND) {
      await remindIfNeeded(env, when);
      return;
    }
    if (cron === CRON_PUBLISH) {
      await publishDue(env, when);
      return;
    }
    if (cron === CRON_NUDGE) {
      await nudgeForPhotosIfNeeded(env, when);
      return;
    }
    console.log(JSON.stringify({ event: "unknown_cron", cron }));
  },
};

async function route(request, env, path) {
  const method = request.method.toUpperCase();

  if (path === "/" && method === "GET") {
    return json(200, {
      ok: true,
      name: "onaroll-posts",
      storage: "kv",
      typography: TYPOGRAPHY_MARK,
    });
  }

  if (path === "/auth/request") {
    if (method !== "POST") return methodNotAllowed("POST");
    return requestSignIn(request, env);
  }
  if (path === "/auth/verify") {
    if (method !== "POST") return methodNotAllowed("POST");
    return verifySignIn(request, env);
  }
  if (path === "/auth/delivery-status") {
    if (method !== "GET") return methodNotAllowed("GET");
    await requireKey(request, env);
    const last = (await env.KV.get(AUTH_LAST_DELIVERY, "json")) || null;
    return json(200, { ok: true, last });
  }

  if (path === "/board") {
    if (method === "GET") {
      await requireKey(request, env);
      return getBoard(env);
    }
    if (method === "PUT") {
      await requireKey(request, env);
      return putBoard(request, env);
    }
    if (method === "DELETE") {
      await requireKey(request, env);
      return deleteBoard(env);
    }
    return methodNotAllowed("GET, PUT, DELETE");
  }

  if (path === "/photos") {
    if (method === "GET") {
      await requireKey(request, env);
      return listPhotos(env, request);
    }
    if (method === "POST") {
      await requireKey(request, env);
      return uploadPhoto(request, env);
    }
    return methodNotAllowed("GET, POST");
  }

  const photoMatch = path.match(/^\/photos\/([A-Za-z0-9_-]+)$/);
  if (photoMatch) {
    const id = photoMatch[1];
    if (!ID_RE.test(id)) return json(404, { error: "not found" });
    if (method === "GET" || method === "HEAD") {
      return servePhoto(env, id, method === "HEAD");
    }
    if (method === "DELETE") {
      await requireKey(request, env);
      return deletePhoto(env, id);
    }
    return methodNotAllowed("GET, DELETE");
  }

  if (path === "/archive") {
    if (method === "GET") {
      await requireKey(request, env);
      return listArchives(env);
    }
    if (method === "POST") {
      await requireKey(request, env);
      return saveArchive(request, env);
    }
    return methodNotAllowed("GET, POST");
  }

  const archiveMatch = path.match(/^\/archive\/([A-Za-z0-9._-]+)$/);
  if (archiveMatch) {
    const id = archiveMatch[1];
    if (!WEEK_ID_RE.test(id)) return json(404, { error: "not found" });
    if (method === "GET") {
      await requireKey(request, env);
      return getArchive(env, id);
    }
    return methodNotAllowed("GET");
  }

  if (path === "/generate") {
    if (method !== "POST") return methodNotAllowed("POST");
    await requireKey(request, env);
    const body = request.headers.get("Content-Type")?.includes("json")
      ? (await readJson(request, MAX_JSON_BYTES)) || {}
      : {};
    const notify = body.notify !== false;
    const result = await generateWeek(env, { source: "manual", notify, now: new Date() });
    return json(200, result);
  }

  if (path === "/ensure-drafts") {
    if (method !== "POST") return methodNotAllowed("POST");
    await requireKey(request, env);
    const result = await ensureDrafts(env, { source: "ensure", notify: false, now: new Date() });
    if (result.pending) return json(202, result);
    return json(200, result);
  }

  if (path === "/schedule" || path === "/schedule-approved") {
    if (method === "GET") {
      await requireKey(request, env);
      return json(200, await scheduleSummary(env, new Date()));
    }
    if (method === "POST") {
      await requireKey(request, env);
      const body = request.headers.get("Content-Type")?.includes("json")
        ? (await readJson(request, MAX_JSON_BYTES)) || {}
        : {};
      const result = await scheduleApproved(env, new Date(), body);
      const status = result.error && result.error !== "not_all_approved" && result.error !== "queue_full" && result.error !== "no_drafts" ? 400 : 200;
      return json(status, result);
    }
    if (method === "DELETE") {
      await requireKey(request, env);
      await env.KV.delete(SCHEDULE_KEY);
      return json(200, { ok: true, weeks: [] });
    }
    return methodNotAllowed("GET, POST, DELETE");
  }

  if (path === "/notify/test") {
    if (method !== "POST") return methodNotAllowed("POST");
    await requireKey(request, env);
    const result = await sendTestNotification(env);
    return json(200, result);
  }

  if (path === "/publish/facebook" || path === "/publish/instagram") {
    if (method !== "POST") return methodNotAllowed("POST");
    await requireKey(request, env);
    return json(501, publishPlaceholder(path.endsWith("instagram") ? "instagram" : "facebook"));
  }

  if (path === "/publish") {
    if (method !== "POST") return methodNotAllowed("POST");
    await requireKey(request, env);
    const body = request.headers.get("Content-Type")?.includes("json")
      ? (await readJson(request, MAX_JSON_BYTES)) || {}
      : {};
    return json(501, publishPlaceholder(body.channel || "facebook"));
  }

  const regenMatch = path.match(/^\/regenerate\/([^/]+)$/);
  if (regenMatch) {
    if (method !== "POST") return methodNotAllowed("POST");
    await requireKey(request, env);
    return regeneratePost(request, env, regenMatch[1]);
  }

  if (path === "/notes") {
    if (method === "GET") {
      await requireKey(request, env);
      return listNotes(env);
    }
    if (method === "POST") {
      await requireKey(request, env);
      return addNote(request, env);
    }
    return methodNotAllowed("GET, POST");
  }

  return json(404, { error: "not found" });
}

function publishPlaceholder(channel) {
  // Later these will use env.META_PAGE_TOKEN, env.META_PAGE_ID, env.META_IG_USER_ID.
  // Instagram needs a public image URL from GET /photos/:id.
  return { error: "Meta not connected yet", channel };
}

/* —— Board —— */

async function getBoard(env) {
  await repairStoredRecords(env);
  const board = await env.KV.get(BOARD_KEY, "json");
  if (!board) return json(200, { updatedAt: null });
  return json(200, board);
}

async function deleteBoard(env) {
  await env.KV.delete(BOARD_KEY);
  await env.KV.delete(DRAFT_LOCK_KEY);
  return json(200, { ok: true, updatedAt: null });
}

async function putBoard(request, env) {
  const body = await readJson(request, MAX_JSON_BYTES);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(400, { error: "board must be a JSON object" });
  }

  const incoming = repairValue({ ...body });
  const base = clientBaseVersion(request, incoming);
  delete incoming.baseUpdatedAt;

  const existing = await env.KV.get(BOARD_KEY, "json");
  if (existing && existing.updatedAt) {
    if (!base || base !== existing.updatedAt) {
      // 409 when the client's base is missing or older (or otherwise not the
      // current server version), so the client can merge and retry.
      if (!base || base < existing.updatedAt || base !== existing.updatedAt) {
        return json(409, {
          error: "conflict",
          message:
            "Board has been updated since your last fetch. Merge with the current board and retry.",
          current: repairValue(existing),
        });
      }
    }
  }

  incoming.updatedAt = new Date().toISOString();
  await env.KV.put(BOARD_KEY, JSON.stringify(incoming));
  return json(200, incoming);
}

function clientBaseVersion(request, body) {
  const header =
    request.headers.get("X-Board-Base") || request.headers.get("If-Match") || "";
  const trimmed = header.trim().replace(/^W\//, "").replaceAll('"', "");
  if (trimmed) return trimmed;
  if (typeof body.baseUpdatedAt === "string" && body.baseUpdatedAt) {
    return body.baseUpdatedAt;
  }
  if (typeof body.updatedAt === "string" && body.updatedAt) {
    return body.updatedAt;
  }
  return null;
}

/* —— Photos —— */

async function listPhotos(env, request) {
  const index = (await env.KV.get(PHOTO_INDEX, "json")) || [];
  const originUrl = new URL(request.url).origin;
  const photos = [];
  for (const entry of index) {
    const meta = (await env.KV.get(PHOTO_META(entry.id), "json")) || entry;
    photos.push({
      id: meta.id,
      url: photoUrl(originUrl, meta.id),
      contentType: meta.contentType || "application/octet-stream",
      size: meta.size || 0,
      createdAt: meta.createdAt,
      filename: meta.filename || null,
    });
  }
  return json(200, { photos });
}

async function uploadPhoto(request, env) {
  const parsed = await readImageUpload(request);
  if (parsed.error) return json(parsed.status || 400, { error: parsed.error });

  const id = randomId();
  const createdAt = new Date().toISOString();
  const meta = {
    id,
    contentType: parsed.contentType,
    size: parsed.bytes.byteLength,
    createdAt,
    filename: parsed.filename || null,
  };

  await env.KV.put(PHOTO_DATA(id), parsed.bytes, {
    metadata: { contentType: meta.contentType },
  });
  await env.KV.put(PHOTO_META(id), JSON.stringify(meta));
  await prependIndex(env, PHOTO_INDEX, { id, createdAt });

  const url = photoUrl(new URL(request.url).origin, id);
  return json(201, { id, url, contentType: meta.contentType, size: meta.size, createdAt });
}

async function servePhoto(env, id, headOnly) {
  const meta = await env.KV.get(PHOTO_META(id), "json");
  const bytes = await env.KV.get(PHOTO_DATA(id), "arrayBuffer");
  if (!meta || !bytes) return json(404, { error: "not found" });

  const headers = {
    "Content-Type": meta.contentType || "application/octet-stream",
    "Content-Length": String(bytes.byteLength),
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  };
  if (headOnly) return new Response(null, { status: 200, headers });
  return new Response(bytes, { status: 200, headers });
}

async function deletePhoto(env, id) {
  const meta = await env.KV.get(PHOTO_META(id), "json");
  if (!meta) return json(404, { error: "not found" });
  await env.KV.delete(PHOTO_DATA(id));
  await env.KV.delete(PHOTO_META(id));
  await removeFromIndex(env, PHOTO_INDEX, id);
  return json(200, { ok: true, id });
}

/* —— Archive —— */

async function listArchives(env) {
  const index = (await env.KV.get(ARCHIVE_INDEX, "json")) || [];
  return json(200, { weeks: index });
}

async function getArchive(env, id) {
  const week = await env.KV.get(ARCHIVE_DATA(id), "json");
  if (!week) return json(404, { error: "not found" });
  return json(200, week);
}

async function saveArchive(request, env) {
  const body = await readJson(request, MAX_JSON_BYTES);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(400, { error: "archive must be a JSON object" });
  }

  const postsIn = Array.isArray(body.posts) ? body.posts : [];
  if (!postsIn.length) {
    return json(400, { error: "archive requires a posts array" });
  }

  const now = new Date().toISOString();
  const id = String(body.id || body.meta?.id || weekIdFromDate(new Date()));
  if (!WEEK_ID_RE.test(id)) {
    return json(400, { error: "invalid archive id" });
  }

  const originUrl = new URL(request.url).origin;
  const posts = [];
  for (const post of postsIn) {
    const saved = { ...post };
    const dataUrl = post.fbDataUrl || post.image || post.dataUrl || null;
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
      const parsed = decodeDataUrl(dataUrl);
      if (parsed.error) return json(parsed.status || 400, { error: parsed.error });
      const photoId = randomId();
      const createdAt = now;
      const meta = {
        id: photoId,
        contentType: parsed.contentType,
        size: parsed.bytes.byteLength,
        createdAt,
        filename: `${id}-${post.id || posts.length}-fb.jpg`,
      };
      await env.KV.put(PHOTO_DATA(photoId), parsed.bytes, {
        metadata: { contentType: meta.contentType },
      });
      await env.KV.put(PHOTO_META(photoId), JSON.stringify(meta));
      await prependIndex(env, PHOTO_INDEX, { id: photoId, createdAt });
      saved.fbPhotoId = photoId;
      saved.fbUrl = photoUrl(originUrl, photoId);
      delete saved.fbDataUrl;
      delete saved.image;
      delete saved.dataUrl;
    } else if (post.fbPhotoId && ID_RE.test(post.fbPhotoId)) {
      saved.fbPhotoId = post.fbPhotoId;
      saved.fbUrl = photoUrl(originUrl, post.fbPhotoId);
    } else if (typeof post.fbUrl === "string") {
      saved.fbUrl = post.fbUrl;
    }
    posts.push(saved);
  }

  const existing = await env.KV.get(ARCHIVE_DATA(id), "json");
  const week = {
    id,
    label: body.label || body.meta?.label || `Week of ${id}`,
    postedAt: body.postedAt || body.meta?.postedAt || now.slice(0, 10),
    file: body.file || body.meta?.file || `${id}.html`,
    html: typeof body.html === "string" ? body.html : existing?.html || null,
    meta: body.meta && typeof body.meta === "object" ? body.meta : undefined,
    posts,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  const listMeta = {
    id: week.id,
    label: week.label,
    postedAt: week.postedAt,
    file: week.file,
    postCount: posts.length,
    createdAt: week.createdAt,
    updatedAt: week.updatedAt,
  };

  await env.KV.put(ARCHIVE_DATA(id), JSON.stringify(week));
  await upsertIndex(env, ARCHIVE_INDEX, listMeta);
  return json(existing ? 200 : 201, week);
}

/* —— Uploads & helpers —— */

async function readImageUpload(request) {
  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();

  if (contentType.includes("application/json")) {
    const body = await readJson(request, MAX_JSON_BYTES);
    if (!body || typeof body !== "object") {
      return { error: "expected a JSON object", status: 400 };
    }
    if (typeof body.dataUrl === "string") {
      const decoded = decodeDataUrl(body.dataUrl);
      if (decoded.error) return decoded;
      decoded.filename = body.filename || null;
      return decoded;
    }
    if (typeof body.base64 === "string") {
      return fromBase64(body.base64, body.contentType || "image/jpeg", body.filename);
    }
    return { error: "send dataUrl or base64", status: 400 };
  }

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file") || form.get("photo") || form.get("image");
    const dataUrl = form.get("dataUrl");
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
      const decoded = decodeDataUrl(dataUrl);
      if (decoded.error) return decoded;
      decoded.filename = typeof form.get("filename") === "string" ? form.get("filename") : null;
      return decoded;
    }
    if (!file || typeof file === "string") {
      return { error: "missing file field (file, photo, or image)", status: 400 };
    }
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength === 0) return { error: "empty file", status: 400 };
    if (bytes.byteLength > MAX_PHOTO_BYTES) {
      return {
        error: `image is too large (${bytes.byteLength} bytes); compress to under ${MAX_PHOTO_BYTES} bytes`,
        status: 413,
      };
    }
    return {
      bytes,
      contentType: safeImageType(file.type || "application/octet-stream"),
      filename: file.name || null,
    };
  }

  if (contentType.startsWith("image/") || contentType === "application/octet-stream") {
    const cl = Number(request.headers.get("Content-Length") || 0);
    if (cl > MAX_PHOTO_BYTES) {
      return {
        error: `image is too large; compress to under ${MAX_PHOTO_BYTES} bytes`,
        status: 413,
      };
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength === 0) return { error: "empty body", status: 400 };
    if (bytes.byteLength > MAX_PHOTO_BYTES) {
      return {
        error: `image is too large (${bytes.byteLength} bytes); compress to under ${MAX_PHOTO_BYTES} bytes`,
        status: 413,
      };
    }
    return {
      bytes,
      contentType: safeImageType(contentType.split(";")[0].trim() || "application/octet-stream"),
      filename: null,
    };
  }

  return { error: "unsupported content type; send an image, multipart file, or JSON dataUrl", status: 415 };
}

function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return { error: "invalid data URL", status: 400 };
  const contentType = safeImageType((match[1] || "application/octet-stream").trim());
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  if (isBase64) return fromBase64(payload, contentType, null);
  try {
    const decoded = decodeURIComponent(payload);
    const bytes = new TextEncoder().encode(decoded).buffer;
    if (bytes.byteLength > MAX_PHOTO_BYTES) {
      return {
        error: `image is too large (${bytes.byteLength} bytes); compress to under ${MAX_PHOTO_BYTES} bytes`,
        status: 413,
      };
    }
    return { bytes, contentType, filename: null };
  } catch {
    return { error: "invalid data URL payload", status: 400 };
  }
}

function fromBase64(b64, contentType, filename) {
  const clean = String(b64).replace(/\s+/g, "");
  // Reject oversized base64 before decoding (~4/3 expansion).
  if (clean.length > Math.ceil(MAX_PHOTO_BYTES * 1.4) + 64) {
    return {
      error: `image is too large; compress to under ${MAX_PHOTO_BYTES} bytes`,
      status: 413,
    };
  }
  let binary;
  try {
    binary = atob(clean);
  } catch {
    return { error: "invalid base64", status: 400 };
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.byteLength === 0) return { error: "empty image", status: 400 };
  if (bytes.byteLength > MAX_PHOTO_BYTES) {
    return {
      error: `image is too large (${bytes.byteLength} bytes); compress to under ${MAX_PHOTO_BYTES} bytes`,
      status: 413,
    };
  }
  return { bytes: bytes.buffer, contentType: safeImageType(contentType), filename: filename || null };
}

function safeImageType(type) {
  const t = String(type || "").toLowerCase().split(";")[0].trim();
  const allowed = new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/heic",
    "image/heif",
  ]);
  if (t === "image/jpg") return "image/jpeg";
  if (allowed.has(t)) return t;
  return "application/octet-stream";
}

async function readJson(request, maxBytes) {
  const cl = Number(request.headers.get("Content-Length") || 0);
  if (cl > maxBytes) {
    const err = new Error(`payload is too large; maximum is ${maxBytes} bytes`);
    err.status = 413;
    throw err;
  }
  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    const err = new Error(`payload is too large; maximum is ${maxBytes} bytes`);
    err.status = 413;
    throw err;
  }
  if (buf.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    const err = new Error("invalid JSON");
    err.status = 400;
    throw err;
  }
}

async function prependIndex(env, key, entry) {
  const index = (await env.KV.get(key, "json")) || [];
  const next = [entry, ...index.filter((item) => item.id !== entry.id)];
  await env.KV.put(key, JSON.stringify(next));
}

async function upsertIndex(env, key, entry) {
  const index = (await env.KV.get(key, "json")) || [];
  const next = [entry, ...index.filter((item) => item.id !== entry.id)];
  await env.KV.put(key, JSON.stringify(next));
}

async function removeFromIndex(env, key, id) {
  const index = (await env.KV.get(key, "json")) || [];
  await env.KV.put(key, JSON.stringify(index.filter((item) => item.id !== id)));
}

function photoUrl(origin, id) {
  return `${origin}/photos/${id}`;
}

function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function weekIdFromDate(d) {
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  const y = monday.getUTCFullYear();
  const m = String(monday.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(monday.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function methodNotAllowed(allow) {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Allow: allow,
    },
  });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/* —— UTF-8 typography: repair UTF-8 that was decoded as Latin-1 —— */

const TYPOGRAPHY_MARK = "— · ’ “” £ →";

function looksLikeMojibake(str) {
  return /[ÂÃâ][-ÿ]/.test(str)
    || /â€[”–“˜™]|Â·|Â£|Ã¢/.test(str);
}

function applyMojibakeReplacements(str) {
  return str
    .replace(/â/g, "—")
    .replace(/â/g, "–")
    .replace(/â/g, "‘")
    .replace(/â/g, "’")
    .replace(/â/g, "“")
    .replace(/â/g, "”")
    .replace(/â¦/g, "…")
    .replace(/â/g, "→")
    .replace(/Â·/g, "·")
    .replace(/Â£/g, "£")
    .replace(/â¬/g, "€")
    .replace(/â€”/g, "—")
    .replace(/â€“/g, "–")
    .replace(/â€˜/g, "‘")
    .replace(/â€™/g, "’")
    .replace(/â€œ/g, "“")
    .replace(/â€/g, "”")
    .replace(/â€¦/g, "…")
    .replace(/Â·/g, "·")
    .replace(/Â£/g, "£");
}

function decodeLatin1Utf8(str) {
  if (!looksLikeMojibake(str)) return applyMojibakeReplacements(str);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c > 255) return applyMojibakeReplacements(str);
    bytes[i] = c;
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded === str ? applyMojibakeReplacements(str) : decoded;
  } catch {
    return applyMojibakeReplacements(str);
  }
}

function repairMojibakeString(input) {
  if (typeof input !== "string" || !input) return input;
  let out = input;
  for (let i = 0; i < 3; i++) {
    const next = decodeLatin1Utf8(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

function repairValue(value) {
  if (typeof value === "string") return repairMojibakeString(value);
  if (Array.isArray(value)) return value.map(repairValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = repairValue(val);
    return out;
  }
  return value;
}

async function repairAndStore(env, key, data) {
  if (data == null) return data;
  const repaired = repairValue(data);
  if (JSON.stringify(repaired) === JSON.stringify(data)) return repaired;
  if (repaired && typeof repaired === "object" && !Array.isArray(repaired) && Object.prototype.hasOwnProperty.call(data, "updatedAt")) {
    repaired.updatedAt = new Date().toISOString();
  }
  await env.KV.put(key, JSON.stringify(repaired));
  return repaired;
}

async function repairStoredRecords(env) {
  for (const key of [BOARD_KEY, SCHEDULE_KEY, HISTORY_KEY, NOTES_KEY]) {
    const data = await env.KV.get(key, "json");
    if (data) await repairAndStore(env, key, data);
  }
  const index = await env.KV.get(ARCHIVE_INDEX, "json");
  if (Array.isArray(index) && index.length) {
    await repairAndStore(env, ARCHIVE_INDEX, index);
    for (const entry of index.slice(0, 40)) {
      if (!entry || !entry.id) continue;
      const week = await env.KV.get(ARCHIVE_DATA(entry.id), "json");
      if (week) await repairAndStore(env, ARCHIVE_DATA(entry.id), week);
    }
  }
}

/* —— Auth & CORS —— */


/* —— Sign-in codes, magic links, and device sessions —— */

const GENERIC_CODE_SENT = "If that's registered, a code is on its way";

function clientIp(request) {
  const cf = request.headers.get("CF-Connecting-IP") || "";
  if (cf.trim()) return cf.trim();
  const xff = request.headers.get("X-Forwarded-For") || "";
  const first = xff.split(",")[0].trim();
  return first || "unknown";
}

function normalizeEmail(raw) {
  return String(raw || "").trim().toLowerCase().replace(/\s+/g, "");
}

function normalizePhone(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  s = s.replace(/[\s().-]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("+")) return "+" + s.slice(1).replace(/\D/g, "");
  const d = s.replace(/\D/g, "");
  if (d.startsWith("0") && d.length === 11) return "+44" + d.slice(1);
  if (d.startsWith("44") && d.length >= 12) return "+" + d;
  if (d.startsWith("7") && d.length === 10) return "+44" + d;
  return "";
}

function parseContact(raw) {
  const s = String(raw || "").trim();
  if (!s) return { error: "empty" };
  if (s.includes("@")) {
    const email = normalizeEmail(s);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "format" };
    return { kind: "email", value: email };
  }
  const phone = normalizePhone(s);
  if (!/^\+44\d{10}$/.test(phone) && !/^\+\d{8,15}$/.test(phone)) return { error: "format" };
  return { kind: "phone", value: phone };
}

function isAllowlisted(env, contact) {
  const emails = notifyEmails(env).map((e) => normalizeEmail(e)).filter(Boolean);
  const phone = normalizePhone(env.WHATSAPP_PHONE || "");
  if (contact.kind === "email") return emails.includes(contact.value);
  if (contact.kind === "phone") return !!phone && phone === contact.value;
  return false;
}

async function sha256Hex(value) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function randomDigits(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += String(bytes[i] % 10);
  return out;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function testHookOk(request, env) {
  const hook = env.AUTH_TEST_HOOK;
  if (!hook) return false;
  const provided = request.headers.get("X-Auth-Test") || "";
  if (!provided) return false;
  return keysMatch(provided, hook);
}

async function bumpRateLimit(env, key, limit, ttlSec) {
  const current = (await env.KV.get(key, "json")) || { n: 0 };
  if (Number(current.n) >= limit) return { ok: false, n: current.n };
  const next = { n: Number(current.n || 0) + 1, at: new Date().toISOString() };
  await env.KV.put(key, JSON.stringify(next), { expirationTtl: ttlSec });
  return { ok: true, n: next.n };
}

async function recordDelivery(env, payload) {
  await env.KV.put(AUTH_LAST_DELIVERY, JSON.stringify({
    at: new Date().toISOString(),
    channel: payload.channel || null,
    ok: !!payload.ok,
    error: payload.error || null,
    test: !!payload.test,
  }));
}

async function requestSignIn(request, env) {
  const body = (await readJson(request, MAX_JSON_BYTES)) || {};
  const contact = parseContact(body.contact);
  const generic = json(200, { ok: true, message: GENERIC_CODE_SENT });
  if (contact.error) {
    return json(400, { ok: false, error: "Enter a mobile number or email" });
  }

  const test = await testHookOk(request, env);
  if (!test) {
    const ip = clientIp(request);
    const ipLimit = await bumpRateLimit(env, AUTH_RL_IP_PREFIX + ip, AUTH_RL_IP_LIMIT, AUTH_RL_IP_TTL_SEC);
    const contactLimit = await bumpRateLimit(
      env,
      AUTH_RL_CONTACT_PREFIX + contact.kind + ":" + contact.value,
      AUTH_RL_CONTACT_LIMIT,
      AUTH_RL_CONTACT_TTL_SEC
    );
    if (!ipLimit.ok || !contactLimit.ok) {
      await recordDelivery(env, { channel: contact.kind, ok: false, error: "rate_limited", test });
      return generic;
    }
  }

  if (!isAllowlisted(env, contact)) {
    await recordDelivery(env, { channel: contact.kind, ok: false, error: "not_allowlisted", test });
    return generic;
  }

  const code = await randomDigits(6);
  const loginId = randomToken();
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SEC * 1000).toISOString();
  const record = {
    contact: contact.value,
    kind: contact.kind,
    codeHash: await sha256Hex(code + ":" + contact.value),
    loginId,
    attempts: 0,
    expiresAt,
    createdAt: new Date().toISOString(),
  };
  await env.KV.put(AUTH_OTP_PREFIX + contact.kind + ":" + contact.value, JSON.stringify(record), { expirationTtl: AUTH_CODE_TTL_SEC });
  await env.KV.put(AUTH_LOGIN_PREFIX + loginId, JSON.stringify({ contact: contact.value, kind: contact.kind }), { expirationTtl: AUTH_CODE_TTL_SEC });

  const link = boardUrl(env).replace(/\/+$/, "") + "/#login=" + loginId;
  const text = [
    `Your On a Roll sign-in code is ${code}. It expires in 10 minutes.`,
    "",
    "Or open this link on any browser:",
    link,
    "",
    "If you didn't ask for this, you can ignore it.",
  ].join("\n");

  if (test) {
    await recordDelivery(env, { channel: contact.kind, ok: true, error: "test_skipped", test: true });
    return json(200, { ok: true, message: GENERIC_CODE_SENT, devCode: code, devLogin: loginId, test: true });
  }

  const delivery = contact.kind === "email"
    ? await sendEmail(env, { to: contact.value, subject: "Your On a Roll sign-in code", text })
    : await sendWhatsApp(env, text);
  await recordDelivery(env, { channel: contact.kind, ok: !!delivery.sent, error: delivery.error || null, test: false });
  return generic;
}

async function loadOtp(env, contact) {
  return (await env.KV.get(AUTH_OTP_PREFIX + contact.kind + ":" + contact.value, "json")) || null;
}

async function clearOtp(env, record) {
  if (!record) return;
  await env.KV.delete(AUTH_OTP_PREFIX + record.kind + ":" + record.contact);
  if (record.loginId) await env.KV.delete(AUTH_LOGIN_PREFIX + record.loginId);
}

async function issueSession(env, contact) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + AUTH_SESSION_TTL_SEC * 1000).toISOString();
  const rec = {
    contact: contact.value,
    kind: contact.kind,
    createdAt: new Date().toISOString(),
    expiresAt,
  };
  const id = await sha256Hex(token);
  await env.KV.put(AUTH_SESSION_PREFIX + id, JSON.stringify(rec), { expirationTtl: AUTH_SESSION_TTL_SEC });
  return { token, expiresAt };
}

async function readSession(env, token) {
  if (!token || String(token).length < 16) return null;
  const id = await sha256Hex(token);
  const rec = await env.KV.get(AUTH_SESSION_PREFIX + id, "json");
  if (!rec || rec.revoked) return null;
  if (rec.expiresAt && Date.parse(rec.expiresAt) <= Date.now()) {
    await env.KV.delete(AUTH_SESSION_PREFIX + id);
    return null;
  }
  return rec;
}

async function verifySignIn(request, env) {
  const body = (await readJson(request, MAX_JSON_BYTES)) || {};
  const loginId = String(body.login || body.loginId || "").trim();
  const code = String(body.code || "").replace(/\s+/g, "");
  let record = null;
  let contact = null;

  if (loginId) {
    const pointer = await env.KV.get(AUTH_LOGIN_PREFIX + loginId, "json");
    if (!pointer || !pointer.contact) {
      return json(401, { ok: false, error: "That link isn't valid or has expired." });
    }
    contact = { kind: pointer.kind, value: pointer.contact };
    record = await loadOtp(env, contact);
    if (!record || record.loginId !== loginId) {
      return json(401, { ok: false, error: "That link isn't valid or has expired." });
    }
  } else {
    contact = parseContact(body.contact);
    if (contact.error) return json(400, { ok: false, error: "Enter a mobile number or email" });
    if (!/^\d{6}$/.test(code)) return json(400, { ok: false, error: "Enter the 6-digit code" });
    record = await loadOtp(env, contact);
    if (!record) return json(401, { ok: false, error: "That code isn't valid or has expired." });
  }

  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
    await clearOtp(env, record);
    return json(401, { ok: false, error: "That code isn't valid or has expired." });
  }

  const attempts = Number(record.attempts || 0);
  if (attempts >= AUTH_MAX_ATTEMPTS) {
    await clearOtp(env, record);
    return json(401, { ok: false, error: "Too many attempts. Send a new code." });
  }

  if (!loginId) {
    const got = await sha256Hex(code + ":" + record.contact);
    // Hash both hex digests again so the comparison stays constant-time and length-stable.
    const match = await keysMatch(got, record.codeHash);
    if (!match) {
      record.attempts = attempts + 1;
      if (record.attempts >= AUTH_MAX_ATTEMPTS) {
        await clearOtp(env, record);
        return json(401, { ok: false, error: "Too many attempts. Send a new code." });
      }
      await env.KV.put(
        AUTH_OTP_PREFIX + record.kind + ":" + record.contact,
        JSON.stringify(record),
        { expirationTtl: AUTH_CODE_TTL_SEC }
      );
      return json(401, { ok: false, error: "That code isn't valid or has expired." });
    }
  }

  await clearOtp(env, record);
  const session = await issueSession(env, contact);
  return json(200, {
    ok: true,
    session: session.token,
    expiresAt: session.expiresAt,
  });
}

async function requireKey(request, env) {
  const expected = env.BOARD_KEY;
  if (!expected) {
    const err = new Error("server not configured");
    err.status = 500;
    throw err;
  }
  const provided = request.headers.get("X-Board-Key") || request.headers.get("X-Board-Session") || "";
  if (!provided) {
    const err = new Error("unauthorized");
    err.status = 401;
    throw err;
  }
  if (await keysMatch(provided, expected)) return { via: "board-key" };
  const session = await readSession(env, provided);
  if (session) return { via: "session", session };
  const err = new Error("unauthorized");
  err.status = 401;
  throw err;
}

async function keysMatch(provided, expected) {
  const enc = new TextEncoder();
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(provided))));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(expected))));
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a[i] ^ b[i];
  return out === 0;
}

function corsOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  try {
    const url = new URL(origin);
    if (
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.protocol === "http:"
    ) {
      return origin;
    }
  } catch {
    return null;
  }
  return null;
}

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Board-Key, X-Board-Session, X-Board-Base, If-Match, X-Auth-Test",
    "Access-Control-Expose-Headers": "Content-Type, Content-Length, ETag, X-Content-Type-Options",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function corsPreflight(origin) {
  if (!origin) {
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  const extra = corsHeaders(origin);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

/* —— Weekly generation —— */

async function generateWeek(env, { source, notify = true, now = new Date(), weekId: forcedWeekId } = {}) {
  const weekId = forcedWeekId || nextWeekMondayId(now);
  const history = await loadHistory(env);
  const unusedNotes = (await loadNotes(env)).filter((n) => !n.usedAt);
  const angles = pickAngles(SLOTS.length, now, history);
  const assignments = assignNotesToSlots(unusedNotes, angles);
  const preferIds = assignments.flatMap((a) => a.note?.photoIds || []);
  const photos = await pickPhotos(env, SLOTS.length, { preferIds });
  const avoidHeadlines = recentHeadlines(history);
  const posts = {};
  const sources = {};
  const usedNotes = [];

  for (let i = 0; i < SLOTS.length; i++) {
    const base = SLOTS[i];
    const angle = angles[i];
    const note = assignments[i]?.note || null;
    const slot = { ...base, angle: angle.label, angleId: angle.id, town: angle.town || null };
    const chosen = photos[i] || null;
    const copy = await writeCopy(env, slot, chosen, weekId, { note, avoidHeadlines });
    const post = buildPost(slot, chosen, copy, note);
    posts[slot.id] = post;
    sources[slot.id] = copy.source;
    if (note) usedNotes.push(note.id);
    avoidHeadlines.push(`${post.line1} ${post.line2}`.replace(/\s+/g, " ").trim().toLowerCase());
  }

  if (usedNotes.length) await markNotesUsed(env, usedNotes, weekId);

  const generatedAt = new Date().toISOString();
  const board = {
    weekId,
    generatedAt,
    generatedBy: source || "manual",
    copySource: sources,
    "001": posts["001"],
    "002": posts["002"],
    "003": posts["003"],
    updatedAt: generatedAt,
  };

  await recordWeekHistory(env, history, board, angles, assignments);

  const freshness = await photoFreshness(env, now);
  let notification = null;
  if (notify) {
    notification = await notify(env, {
      type: "ready",
      board,
      ask: freshness.sundayAsk ? `${PHOTO_ASK} ${boardUrl(env)}` : null,
    });
    board._notify = {
      needsReview: true,
      boardUrl: boardUrl(env),
      sentAt: notification.sentAt,
      channels: notification.channels,
      ask: freshness.sundayAsk || false,
    };
  }

  await env.KV.put(BOARD_KEY, JSON.stringify(board));
  return {
    ok: true,
    weekId,
    generatedAt,
    generatedBy: board.generatedBy,
    copySource: sources,
    photos: photos.map((p) => ({ id: p.id, label: p.label || null, origin: p.origin })),
    angles: angles.map((a) => ({ id: a.id, group: a.group, town: a.town || undefined })),
    notesUsed: usedNotes,
    freshness,
    notification,
    board,
  };
}

async function regeneratePost(request, env, dayRaw) {
  const slotId = parseDaySlot(dayRaw);
  if (!slotId) return json(400, { error: "day must be monday, wednesday or friday" });
  const slotBase = SLOTS.find((s) => s.id === slotId);
  const existing = (await env.KV.get(BOARD_KEY, "json")) || null;
  if (!existing || !existing[slotId]) {
    return json(404, { error: "no post for that day yet — generate the week first" });
  }

  const url = new URL(request.url);
  const newPhoto = ["1", "true", "new", "yes"].includes((url.searchParams.get("photo") || "").toLowerCase());
  const now = new Date();
  const weekId = existing.weekId || nextWeekMondayId(now);
  const history = await loadHistory(env);
  const currentAngleIds = SLOTS.map((s) => existing[s.id]?.angleId).filter(Boolean);
  const angles = pickAngles(1, now, history, currentAngleIds);
  const angle = angles[0];
  const unusedNotes = (await loadNotes(env)).filter((n) => !n.usedAt);
  const note = unusedNotes[0] || null;
  const current = existing[slotId];
  let photo = await photoFromBoard(env, current);
  if (newPhoto || !photo) {
    const preferIds = note?.photoIds || [];
    const picked = await pickPhotos(env, 1, {
      preferIds,
      excludeIds: photo ? [photo.id] : [],
    });
    photo = picked[0] || photo;
  }
  const slot = { ...slotBase, angle: angle.label, angleId: angle.id, town: angle.town || null };
  const copy = await writeCopy(env, slot, photo, weekId, {
    note,
    avoidHeadlines: recentHeadlines(history).concat(
      SLOTS.map((s) => `${existing[s.id]?.line1 || ""} ${existing[s.id]?.line2 || ""}`.replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean),
    ),
  });
  const post = buildPost(slot, photo, copy, note);
  if (note) await markNotesUsed(env, [note.id], weekId);

  const updatedAt = now.toISOString();
  const copySource = { ...(existing.copySource || {}), [slotId]: copy.source };
  const board = {
    ...existing,
    copySource,
    [slotId]: post,
    updatedAt,
  };
  await env.KV.put(BOARD_KEY, JSON.stringify(board));
  await recordWeekHistory(env, history, board, null, null);
  return json(200, {
    ok: true,
    day: slotBase.day,
    slot: slotId,
    photoChanged: newPhoto,
    noteUsed: note ? note.id : null,
    angle: { id: angle.id, group: angle.group, town: angle.town || undefined },
    post,
    board,
  });
}


function buildPost(slot, photo, copy, note) {
  const hashtagSlot = slot.angleId === "security" ? "002" : slot.angleId === "free-survey" ? "003" : slot.id;
  const post = {
    photo: photo ? photo.boardPhoto : null,
    customPhoto: photo && photo.origin === "upload" ? photo.id : null,
    line1: copy.line1,
    line2: copy.line2,
    sub: copy.sub,
    cta: DEFAULT_CTA,
    showPrice: false,
    priceFrom: DEFAULT_PRICE_FROM,
    priceAmount: "",
    status: "awaiting",
    variant: 0,
    angle: slot.angle,
    angleId: slot.angleId || null,
    town: slot.town || null,
    noteId: note?.id || null,
  };
  post.caption = buildCaption(post, hashtagSlot, slot.town);
  return post;
}


function buildCaption(post, slotId, town) {
  const hook = endCleanly(`${post.line1 || ""} ${post.line2 || ""}`.replace(/\s+/g, " ").trim());
  const sub = endCleanly(String(post.sub || "").replace(/\s+/g, " ").trim());
  let body = hook;
  if (sub && sub.toLowerCase() !== hook.toLowerCase()) {
    body = hook ? `${hook} ${sub}` : sub;
  }
  if (!body) body = "Made-to-measure garage doors, fitted locally.";
  const lead = startCaps(endCleanly(body));
  let tags = HASHTAGS[slotId] || HASHTAGS["001"];
  if (town) {
    const tag = "#" + town.replace(/[^A-Za-z]/g, "");
    if (!tags.toLowerCase().includes(tag.toLowerCase())) tags = `${tags} ${tag}`;
  }
  return `${lead}\n\nFree survey → ${PHONE} · WhatsApp ${WHATSAPP_DISPLAY}\nonarollgaragedoors.co.uk\n\n${BRAND_SIGN_OFF}\n\n${tags}`;
}


function endCleanly(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (/[.!?]$/.test(value)) return value;
  return `${value}.`;
}

function nextWeekMondayId(d) {
  const day = (d.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  const add = day === 6 ? 1 : day === 0 && d.getUTCHours() >= 18 ? 7 : -day;
  // Sunday (any time, including the 18:00 cron): next Monday.
  // Monday 18:00 or later (manual): the following Monday.
  // Tuesday–Saturday: this week's Monday (regenerate the current week).
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (day === 6) monday.setUTCDate(monday.getUTCDate() + 1);
  else if (day === 0 && d.getUTCHours() >= 18) monday.setUTCDate(monday.getUTCDate() + 7);
  else monday.setUTCDate(monday.getUTCDate() - day);
  const y = monday.getUTCFullYear();
  const m = String(monday.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(monday.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/* —— Photos —— */

async function pickPhotos(env, count, { preferIds = [], excludeIds = [], record = true } = {}) {
  const pool = await loadPhotoPool(env);
  const used = (await env.KV.get(PHOTO_USED, "json")) || { items: {} };
  const items = used.items || used; // tolerate a flat map
  const now = new Date().toISOString();
  const excluded = new Set(excludeIds.filter(Boolean));
  const byId = new Map(pool.map((p) => [p.id, p]));

  const unusedUploads = [];
  const unusedManifest = [];
  const usedUploads = [];
  const usedManifest = [];
  for (const photo of pool) {
    if (excluded.has(photo.id)) continue;
    const isUsed = !!(items[photo.id] && items[photo.id].usedAt);
    if (photo.origin === "upload") {
      (isUsed ? usedUploads : unusedUploads).push(photo);
    } else {
      (isUsed ? usedManifest : unusedManifest).push(photo);
    }
  }
  unusedUploads.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  usedUploads.sort((a, b) => String(items[a.id].usedAt).localeCompare(String(items[b.id].usedAt)));
  usedManifest.sort((a, b) => String(items[a.id].usedAt).localeCompare(String(items[b.id].usedAt)));

  const prefer = [];
  for (const id of preferIds) {
    const photo = byId.get(id);
    if (photo && !excluded.has(id)) prefer.push(photo);
  }

  const ordered = [...prefer, ...unusedUploads, ...unusedManifest, ...usedUploads, ...usedManifest];
  const picked = [];
  const pickedIds = new Set();
  for (const photo of ordered) {
    if (picked.length >= count) break;
    if (pickedIds.has(photo.id)) continue;
    picked.push(photo);
    pickedIds.add(photo.id);
  }
  let i = 0;
  while (picked.length < count && ordered.length) {
    picked.push(ordered[i % ordered.length]);
    i += 1;
  }

  if (record && picked.length) {
    const nextItems = { ...items };
    for (const photo of picked) {
      const prev = nextItems[photo.id] || { count: 0 };
      nextItems[photo.id] = { usedAt: now, count: (prev.count || 0) + 1, origin: photo.origin };
    }
    await env.KV.put(PHOTO_USED, JSON.stringify({ items: nextItems, updatedAt: now }));
  }
  return picked;
}


async function loadPhotoPool(env) {
  const pool = [];
  const seen = new Set();

  try {
    const res = await fetch(`${MANIFEST_URL}?ts=${Date.now()}`, { cf: { cacheTtl: 0 } });
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.photos || [];
      for (const item of list) {
        if (!item || !item.id) continue;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        pool.push({
          id: item.id,
          label: item.label || item.id,
          origin: "manifest",
          boardPhoto: item.id,
          src: item.src || null,
        });
      }
    } else {
      console.log(JSON.stringify({ event: "manifest_fetch_failed", status: res.status }));
    }
  } catch (err) {
    console.log(JSON.stringify({ event: "manifest_fetch_error", error: String(err && err.message || err) }));
  }

  const index = (await env.KV.get(PHOTO_INDEX, "json")) || [];
  for (const entry of index) {
    const id = entry.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    pool.push({
      id,
      label: entry.filename || "Uploaded photo",
      origin: "upload",
      boardPhoto: id,
      src: null,
      createdAt: entry.createdAt || null,
    });
  }
  return pool;
}

/* —— Copy —— */

async function writeCopy(env, slot, photo, weekId, context = {}) {
  if (env.AI && typeof env.AI.run === "function") {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const generated = await generateWithAi(env, slot, photo, weekId, attempt, context);
      if (generated) return { ...generated, source: "ai", attempt };
    }
  }
  return { ...templateCopy(slot, weekId, context), source: "template" };
}

async function generateWithAi(env, slot, photo, weekId, attempt, context = {}) {
  const model = AI_MODELS[(attempt - 1) % AI_MODELS.length];
  const example = '{"line1":"Old door out.","line2":"New door in.","sub":"Made-to-measure roller, fitted tidy by the local team."}';
  const prompt = [
    "Write one social post for On a Roll Garage Doors, a family-run garage door fitter in Poole,",
    "covering Poole, Bournemouth, Christchurch and Dorset.",
    "Voice: local, honest, plain English. Like a tradesperson talking to a neighbour, not an advert.",
    "Use sentence case. Never Title Case. Never shout in ALL CAPS.",
    "Do not invent jobs, job details, job locations, prices, reviews, star ratings, accreditations or a founding year.",
    "Never name a town, street or 'town centre' unless that place appears in the inspiration note, or the photo label is clearly a real place name (not a generic label like 'Install 7').",
    "If the angle is a local-area spotlight, talk about serving that town — that you cover it and will come out — and do not claim you have just done a job there.",
    "Do not use: guarantee, guaranteed, best, cheapest, No.1, #1, or any superlatives or salesy claims.",
    "No pound signs, no prices, no 'since ...', no testimonials.",
    "Warranty, if mentioned at all, may only be written exactly as '5-year warranty'.",
    "This is a garage door company. Do not mention driveways, resin, paving or tarmac.",
    "Garage door springs and cables are under high tension and are dangerous. Never tell people to check, tug, tighten, loosen, oil, touch or adjust springs, cables or tension. For maintenance, tell them to spot the signs (a door that's heavy, noisy or uneven) and then call us.",
    "Start line1 and sub with a capital letter. line2 only needs a capital if it starts a new sentence.",
    `This post is for ${slot.day}. Angle: ${slot.angle}.`,
    context.note && context.note.text
      ? `Jon left this inspiration note. Use it faithfully. Do not invent extra job details, names or towns that are not in the note: "${String(context.note.text).slice(0, NOTE_MAX)}"`
      : "",
    photo && photo.origin === "upload"
      ? "The photo is one of Jon's own recent uploads. Talk generally about a real install photo; do not invent a town or job unless the inspiration note names one."
      : photo && photo.label
        ? `The photo is one of Jon's real install photos (internal label: ${photo.label}). Do not mention that label in the copy. Only use a town or job detail if the label clearly contains a real place or description, not a generic name like "Install 7".`
        : "Do not invent a specific town or job.",
    Array.isArray(context.avoidHeadlines) && context.avoidHeadlines.length
      ? `Do not repeat or closely rephrase any of these recent headlines: ${context.avoidHeadlines.slice(-24).join(" | ")}.`
      : "",
    "Return ONLY a JSON object, no markdown, no preamble, with exactly these keys: line1, line2, sub.",
    `line1: first headline line, max ${LINE_MAX} characters, sentence case. It may be a short phrase.`,
    `line2: finishes the headline, max ${LINE_MAX} characters, sentence case, ending with a full stop or question mark.`,
    `sub: one supporting sentence, max ${SUB_MAX} characters, sentence case, ending with a full stop.`,
    "line1 plus line2 should read naturally as one short sentence when joined with a space.",
    "Every field must be a complete phrase. Never end mid-thought, e.g. do not end with 'for', 'to', 'with' or 'and'.",
    "No hashtags, no phone numbers, no website, no CTA in these fields — those are added later.",
    "Example of the exact shape and tone:",
    example,
    attempt === 2 ? "A previous draft failed the brand checks. Write a shorter, plainer draft in sentence case, with punctuation at the end of line2 and sub." : "",
  ].filter(Boolean).join(" ");

  try {
    const input = {
      messages: [
        { role: "system", content: "You only output a single valid JSON object. No markdown fences, no commentary." },
        { role: "user", content: prompt },
      ],
      max_tokens: 400,
      temperature: attempt === 1 ? 0.5 : 0.3,
      // GLM-4.7-Flash otherwise spends its token budget on hidden reasoning
      // and returns content: null. This flag is ignored by models that do not use it.
      chat_template_kwargs: { enable_thinking: false },
    };
    let result;
    try {
      result = await env.AI.run(model, { ...input, response_format: { type: "json_object" } });
    } catch {
      result = await env.AI.run(model, input);
    }
    const raw = aiText(result);
    const parsed = parseJsonObject(raw);
    if (!parsed) {
      console.log(JSON.stringify({ event: "copy_parse_failed", slot: slot.id, attempt, model }));
      return null;
    }
    const copy = sentenceCaseCopy({
      line1: tidyLine(parsed.line1, LINE_MAX),
      line2: endCleanly(tidyLine(parsed.line2, LINE_MAX)),
      sub: endCleanly(tidyLine(parsed.sub, SUB_MAX)),
    });
    copy.model = model;
    const reason = validateCopy(copy, {
      note: context.note,
      photo,
      town: slot.town,
      angleId: slot.angleId,
    });

    if (reason) {
      console.log(JSON.stringify({ event: "copy_rejected", slot: slot.id, reason, attempt, model }));
      return null;
    }
    if (!copy.line1 || !copy.line2) {
      console.log(JSON.stringify({ event: "copy_empty", slot: slot.id, attempt, model }));
      return null;
    }
    const headline = `${copy.line1} ${copy.line2}`.replace(/\s+/g, " ").trim().toLowerCase();
    if (Array.isArray(context.avoidHeadlines) && context.avoidHeadlines.includes(headline)) {
      console.log(JSON.stringify({ event: "copy_repeated", slot: slot.id, attempt, model }));
      return null;
    }
    return copy;
  } catch (err) {
    console.log(JSON.stringify({
      event: "ai_failed",
      slot: slot.id,
      attempt,
      model,
      error: String(err && err.message || err),
    }));
    return null;
  }
}

function aiText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  const message =
    result.choices?.[0]?.message ||
    result.result?.choices?.[0]?.message ||
    null;
  const chunks = [
    result.response,
    result.result?.response,
    message?.content,
    result.output_text,
    result.result,
  ];
  for (const chunk of chunks) {
    const text = flattenAiChunk(chunk);
    if (text) return text;
  }
  const reasoning = flattenAiChunk(message?.reasoning);
  if (reasoning && reasoning.includes("{")) return reasoning;
  return "";
}

function flattenAiChunk(chunk) {
  if (!chunk) return "";
  if (typeof chunk === "string") return chunk.trim() ? chunk : "";
  if (Array.isArray(chunk)) {
    return chunk
      .map((part) => (typeof part === "string" ? part : part?.text || part?.content || ""))
      .join("")
      .trim();
  }
  return "";
}

function parseJsonObject(text) {
  if (!text) return null;
  let raw = String(text).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  raw = raw.slice(start, end + 1);
  const attempts = [
    raw,
    raw.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"),
    raw.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, "$1"),
    raw.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, "$1").replace(/\n/g, " "),
  ];
  for (const candidate of attempts) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
    } catch {
      // try the next loosening
    }
  }
  return null;
}

function tidyLine(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space >= 20 ? cut.slice(0, space) : cut).trim();
}

function validateCopy(copy, context = {}) {
  const line1 = String(copy?.line1 || "");
  const line2 = String(copy?.line2 || "");
  const sub = String(copy?.sub || "");
  const value = `${line1} ${line2} ${sub}`;
  if (value.includes("£") || value.includes("&pound;")) return "price_symbol";
  if (/\bsince\b/i.test(value)) return "since";
  if (/\breview/i.test(value)) return "review";
  if (/\bstars?\b/i.test(value)) return "star";
  if (/\bguarantees?d?\b/i.test(value)) return "guarantee";
  if (/\bbest\b/i.test(value)) return "best";
  if (/\bcheapest\b/i.test(value)) return "cheapest";
  if (/\bno\.?\s*1\b/i.test(value) || /#1\b/.test(value) || /\bnumber\s+one\b/i.test(value)) return "no1";
  if (/\b(finest|greatest|unbeatable|unmatched|perfect|amazing|incredible|award-?winning|top-?rated|lowest|world'?s|leading|ultimate)\b/i.test(value)) {
    return "superlative";
  }
  const years = value.match(/\d+\s*-?\s*years?\b/gi) || [];
  for (const match of years) {
    const normalised = match.toLowerCase().replace(/\s+/g, "").replace(/s$/, "");
    if (normalised !== "5-year") return "year";
  }
  if (isTitleCase(line1) || isTitleCase(line2)) return "title_case";
  if (isIncompleteLine(line1) || isIncompleteLine(line2) || isIncompleteLine(sub)) return "incomplete";
  if (inventedLocation(value, context)) return "invented_location";
  if (isOffTrade(value)) return "off_trade";
  if (isUnsafeDiy(value)) return "unsafe_diy";
  if (line1.length > LINE_MAX || line2.length > LINE_MAX) return "too_long";
  if (sub.length > SUB_MAX) return "too_long";
  if (`${line1} ${line2} ${sub}`.length > CAPTION_MAX) return "too_long";
  return null;
}


function startCaps(text) {
  const value = String(text || "");
  const match = value.match(/^([^A-Za-z]*)([a-zà-öø-ÿ])([\s\S]*)$/);
  if (!match) return value;
  return match[1] + match[2].toUpperCase() + match[3];
}

function sentenceCaseCopy(copy) {
  const line1 = startCaps(String(copy?.line1 || ""));
  const line2raw = String(copy?.line2 || "");
  const line1Ends = /[.!?]$/.test(line1.trim());
  const line2 = !line1 || line1Ends || /^[^A-Za-z]*[A-Z]/.test(line2raw) ? startCaps(line2raw) : line2raw;
  return {
    ...copy,
    line1,
    line2,
    sub: startCaps(String(copy?.sub || "")),
  };
}

function isOffTrade(value) {
  return /\b(driveways?|resin|paving|tarmac|asphalt|block\s*paving|patios?)\b/i.test(String(value || ""));
}

function isUnsafeDiy(value) {
  // Strip clear warnings ("don't touch the springs — call us") so they stay allowed.
  const text = String(value || "").replace(
    /\b(do\s*not|don't|dont|never|avoid|leave)\s+(?:trying\s+to\s+)?(?:touch|tug|tighten|loosen|adjust|check|inspect|wind|oil|replace|pull)[^.!?]{0,40}\b(springs?|cables?|tension)\b/gi,
    " ",
  );
  const hardware = /\b(springs?|cables?|tension)\b/i;
  const diy = /\b(tug|tighten|loosen|adjust|wind|unwind|oil|lubricat|grease|spray|replace|fix|touch|poke|inspect|check|test|service|pull|twist)\b/i;
  if (hardware.test(text) && diy.test(text)) return true;
  if (/\b(check|tug|tighten|loosen|adjust|touch|inspect|test|wind|oil|replace|pull)\b[^.!?]{0,30}\b(springs?|cables?|tension)\b/i.test(text)) return true;
  if (/\b(springs?|cables?|tension)\b[^.!?]{0,30}\b(tug|tighten|loosen|adjust|touch|check|inspect|oil|replace|wind|pull)\b/i.test(text)) return true;
  return false;
}

function isIncompleteLine(text) {
  const t = String(text || "").trim();
  if (/\b(for|to|with|and|or|a|an|the|of|by|from)[.!?]$/i.test(t)) return true;
  // "a job in." / "a home in." are unfinished; "New door in." and "the easy way in." are fine.
  if (/\b(job|home|house|place|town|area)\s+in[.!?]?$/i.test(t)) return true;
  if (/\bjust finished a job in\b/i.test(t)) return true;
  if (/\b(finished|fitted|installed)\s+a\s+job\s+in\b/i.test(t)) return true;
  return false;
}

function allowedPlaces(context) {
  const places = new Set();
  const blobs = [
    context?.note?.text,
    context?.photo?.label,
    context?.photoLabel,
  ];
  for (const blob of blobs) {
    const text = String(blob || "");
    if (!text || /^install\s*\d+/i.test(text) || /^(security|local fit|roller install)$/i.test(text)) continue;
    for (const town of LOCAL_TOWNS) {
      if (new RegExp(`\\b${town}\\b`, "i").test(text)) places.add(town.toLowerCase());
    }
  }
  return places;
}

function inventedLocation(value, context = {}) {
  const text = String(value || "");
  const allowed = allowedPlaces(context);
  const spotlight = String(context.town || "").trim();
  const isSpotlight = !!(spotlight && (context.angleId || "").startsWith("local-"));

  if (/\btown\s+cent(?:re|er)\b/i.test(text) && !allowed.size) return true;

  for (const town of LOCAL_TOWNS) {
    if (!new RegExp(`\\b${town}\\b`, "i").test(text)) continue;
    if (allowed.has(town.toLowerCase())) continue;

    const jobClaim = new RegExp(
      `\\b(just (did|done|fitted|finished)|fitted a|finished a|installed a|a job in|job in)\\b[^.!?]{0,50}\\b${town}\\b|\\b${town}\\b[^.!?]{0,40}\\b(today|this week|town\\s+cent(?:re|er))\\b`,
      "i",
    );
    if (jobClaim.test(text)) return true;

    if (isSpotlight && town.toLowerCase() === spotlight.toLowerCase()) {
      // Serving the town is the point of a local spotlight. A specific job there is not.
      continue;
    }

    // Poole as the family-run base, or a covering/across/around list, is brand language.
    const covering = new RegExp(
      `\\b(family-?run|based|local team|fitters?|from|covering|we cover|we come|come out|across|around|serving|area)\\b[^.!?]{0,60}\\b${town}\\b|\\b${town}\\b[^.!?]{0,60}\\b(and around|and the surrounding|area|fitters?|team)\\b`,
      "i",
    );
    if (covering.test(text)) continue;

    // Any other named town is an invented job location.
    return true;
  }
  return false;
}

function isTitleCase(text) {
  // Split on sentence breaks so "Warm. Quiet." is allowed, but "New Garage Door" is not.
  const phrases = String(text || "").split(/[.!?]+/);
  const skip = /^(a|an|the|and|or|for|of|in|to|on|is|it)$/i;
  for (const phrase of phrases) {
    const words = phrase
      .replace(/[^A-Za-z0-9'’]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (words.length < 2) continue;
    const rest = words.slice(1).filter((w) => !skip.test(w));
    if (!rest.length) continue;
    const titled = rest.filter((w) => /^[A-Z]/.test(w));
    if (titled.length >= 1 && titled.length / rest.length >= 0.7) return true;
  }
  return false;
}

function templateCopy(slot, weekId, context = {}) {
  const packs = {
    "001": [
      { line1: "Just fitted.", line2: "Looks the part.", sub: "Made-to-measure roller, fitted tidy by our local team." },
      { line1: "Old door out.", line2: "New door in.", sub: "A clean swap, usually done in about half a day." },
      { line1: "Another garage,", line2: "sorted locally.", sub: "Colour-matched aluminium roller, fitted in Poole and around Dorset." },
    ],
    "002": [
      { line1: "Secure it.", line2: "Quiet it.", sub: "Modern rollers lock into the side guides and keep the garage warmer." },
      { line1: "The garage is", line2: "the easy way in.", sub: "A proper roller locks as it closes — and it’s quieter and better insulated." },
      { line1: "Warm. Quiet.", line2: "Harder to force.", sub: "A 5-year warranty on a door that shuts smoothly and stays shut." },
    ],
    "003": [
      { line1: "Free survey.", line2: "Straight talk.", sub: "We’ll measure up, talk you through the options and give you a clear quote." },
      { line1: "Book a survey.", line2: "No hard sell.", sub: "Family-run in Poole. We come to you across Bournemouth, Christchurch and Dorset." },
      { line1: "Ready for a", line2: "new garage door?", sub: "A free survey is the first step — local fitters, honest advice." },
    ],
  };
  const list = packs[slot.id] || packs["001"];
  const seed = Number(String(weekId).replace(/\D/g, "").slice(-2) || 0);
  const avoided = new Set((context.avoidHeadlines || []).map((h) => String(h).toLowerCase()));
  let pick = null;
  for (let i = 0; i < list.length; i++) {
    const candidate = list[(seed + i) % list.length];
    const headline = `${candidate.line1} ${candidate.line2}`.replace(/\s+/g, " ").trim().toLowerCase();
    if (avoided.has(headline)) continue;
    if (validateCopy(candidate)) continue;
    pick = candidate;
    break;
  }
  if (!pick) {
    return sentenceCaseCopy({ line1: "Made to measure.", line2: "Fitted locally.", sub: "Family-run garage door fitters in Poole, covering Dorset." });
  }
  return sentenceCaseCopy(pick);
}


/* —— Freshness, notes, and angles —— */

async function loadHistory(env) {
  const data = (await env.KV.get(HISTORY_KEY, "json")) || { weeks: [] };
  const repaired = await repairAndStore(env, HISTORY_KEY, data);
  const weeks = Array.isArray(repaired) ? repaired : repaired.weeks || [];
  return weeks.filter(Boolean).slice(-HISTORY_WEEKS);
}

async function recordWeekHistory(env, history, board, angles, assignments) {
  const posts = SLOTS.map((slot, i) => {
    const post = board[slot.id] || {};
    const angle = angles && angles[i];
    return {
      slot: slot.id,
      day: slot.day,
      line1: post.line1 || "",
      line2: post.line2 || "",
      sub: post.sub || "",
      angle: post.angle || angle?.label || "",
      angleId: post.angleId || angle?.id || null,
      town: post.town || angle?.town || null,
      photo: post.customPhoto || post.photo || null,
      noteId: post.noteId || assignments?.[i]?.note?.id || null,
    };
  });
  const previous = (history || []).find((w) => w && w.weekId === board.weekId) || null;
  const seen = new Set([
    ...((previous && previous.seenHeadlines) || []),
    ...recentHeadlines([previous].filter(Boolean)),
    ...posts.map((post) => `${post.line1 || ""} ${post.line2 || ""}`.replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean),
  ]);
  const entry = {
    weekId: board.weekId,
    generatedAt: board.generatedAt || board.updatedAt || new Date().toISOString(),
    posts,
    seenHeadlines: [...seen],
  };
  const next = (history || []).filter((w) => w && w.weekId !== entry.weekId);
  next.push(entry);
  await env.KV.put(HISTORY_KEY, JSON.stringify({ weeks: next.slice(-HISTORY_WEEKS) }));
}

function recentHeadlines(history) {
  const list = [];
  const seen = new Set();
  const add = (headline) => {
    const value = String(headline || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!value || seen.has(value)) return;
    seen.add(value);
    list.push(value);
  };
  for (const week of history || []) {
    for (const headline of week.seenHeadlines || []) add(headline);
    for (const post of week.posts || []) {
      add(`${post.line1 || ""} ${post.line2 || ""}`);
    }
  }
  return list;
}

function recentAngleIds(history) {
  const ids = new Set();
  for (const week of history || []) {
    for (const post of week.posts || []) {
      if (post.angleId) ids.add(post.angleId);
    }
  }
  return ids;
}

function recentTowns(history) {
  const towns = [];
  for (const week of history || []) {
    for (const post of week.posts || []) {
      if (post.town) towns.push(post.town);
      if (post.angleId && post.angleId.startsWith("local-")) {
        const name = post.angleId.slice("local-".length);
        const match = LOCAL_TOWNS.find((t) => t.toLowerCase() === name);
        if (match) towns.push(match);
      }
    }
  }
  return towns;
}

function nextTown(history) {
  const used = new Set(recentTowns(history).map((t) => t.toLowerCase()));
  const fresh = LOCAL_TOWNS.filter((t) => !used.has(t.toLowerCase()));
  return (fresh.length ? fresh : LOCAL_TOWNS)[0];
}

function localAngle(history) {
  const town = nextTown(history);
  return {
    id: `local-${town.toLowerCase()}`,
    group: "local",
    town,
    label: `a local-area spotlight on ${town} — we cover this area; do not invent a specific job there unless an inspiration note describes one`,
  };
}

function angleCandidates(now, history) {
  const month = now.getUTCMonth() + 1;
  const list = [];
  for (const def of ANGLE_DEFS) {
    if (def.group === "seasonal" && !(def.months || []).includes(month)) continue;
    if (def.group === "local") {
      list.push(localAngle(history));
      continue;
    }
    list.push({ id: def.id, group: def.group, label: def.label });
  }
  return list;
}

function pickAngles(count, now, history, excludeIds = []) {
  const recent = recentAngleIds(history);
  for (const id of excludeIds) recent.add(id);
  const candidates = angleCandidates(now, history);
  const fresh = candidates.filter((c) => !recent.has(c.id));
  const reused = candidates.filter((c) => recent.has(c.id));
  const seed = Number(String(nextWeekMondayId(now)).replace(/\D/g, "").slice(-4) || 0) + (history?.length || 0) * 7 + excludeIds.length * 13;
  const ordered = [...stableShuffle(fresh, seed), ...stableShuffle(reused, seed + 99)];
  const picked = [];
  const groups = new Set();
  for (const pass of [true, false]) {
    for (const candidate of ordered) {
      if (picked.length >= count) break;
      if (picked.some((p) => p.id === candidate.id)) continue;
      if (pass && groups.has(candidate.group)) continue;
      picked.push(candidate);
      groups.add(candidate.group);
    }
  }
  while (picked.length < count && candidates.length) {
    picked.push(candidates[picked.length % candidates.length]);
  }
  return picked.slice(0, count);
}

function stableShuffle(list, seed) {
  const copy = [...list];
  let x = (Number(seed) || 1) % 2147483647;
  if (x <= 0) x += 2147483646;
  for (let i = copy.length - 1; i > 0; i--) {
    x = (x * 16807) % 2147483647;
    const j = x % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function angleForNote(note, angles) {
  const text = String(note?.text || "").toLowerCase();
  const prefer = [];
  if (/\b(before|after|replaced|rip\s*out|old door)\b/.test(text)) prefer.push("before-after", "recent-install");
  if (/\b(fitted|install|finished|today|this week|job)\b/.test(text)) prefer.push("recent-install");
  if (/\b(lock|secure|security)\b/.test(text)) prefer.push("security");
  if (/\b(warm|insulat|quiet|draught)\b/.test(text)) prefer.push("insulation");
  if (/\b(survey|measure)\b/.test(text)) prefer.push("free-survey");
  if (/\b(colour|color|finish|ral)\b/.test(text)) prefer.push("colours");
  if (/\b(maintain|service|lubricat|spring)\b/.test(text)) prefer.push("maintenance");
  for (const town of LOCAL_TOWNS) {
    if (text.includes(town.toLowerCase())) prefer.push(`local-${town.toLowerCase()}`);
  }
  for (const id of prefer) {
    const match = angles.find((a) => a.id === id);
    if (match) return match;
  }
  return null;
}

function assignNotesToSlots(notes, angles) {
  const leftover = [...(notes || [])];
  const used = new Set();
  const assignments = angles.map((angle) => {
    const idx = leftover.findIndex((n, i) => !used.has(i) && angleForNote(n, [angle]));
    const fallback = leftover.findIndex((n, i) => !used.has(i));
    const pick = idx >= 0 ? idx : fallback;
    if (pick < 0) return { angle, note: null };
    used.add(pick);
    return { angle, note: leftover[pick] };
  });
  return assignments;
}

async function loadNotes(env) {
  const data = (await env.KV.get(NOTES_KEY, "json")) || { notes: [] };
  const repaired = await repairAndStore(env, NOTES_KEY, data);
  const notes = Array.isArray(repaired) ? repaired : repaired.notes || [];
  return notes.filter((n) => n && n.id && n.text);
}

async function saveNotes(env, notes) {
  await env.KV.put(NOTES_KEY, JSON.stringify({ notes, updatedAt: new Date().toISOString() }));
}

async function listNotes(env) {
  const notes = await loadNotes(env);
  const ordered = [
    ...notes.filter((n) => !n.usedAt).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
    ...notes.filter((n) => n.usedAt).sort((a, b) => String(b.usedAt).localeCompare(String(a.usedAt))),
  ];
  return json(200, { notes: ordered });
}

async function addNote(request, env) {
  const body = (await readJson(request, MAX_JSON_BYTES)) || {};
  const photoIds = Array.isArray(body.photoIds)
    ? body.photoIds.map((id) => String(id || "").trim()).filter((id) => ID_RE.test(id) || /^stock-\d+$/i.test(id) || /^up-/.test(id)).slice(0, 8)
    : [];
  const text = String(body.text || "").replace(/\s+/g, " ").trim();
  if (!text && !photoIds.length) return json(400, { error: "text is required" });
  if (text.length > NOTE_MAX) return json(400, { error: `text must be ${NOTE_MAX} characters or fewer` });
  const note = {
    id: randomId(),
    text,
    photoIds,
    createdAt: new Date().toISOString(),
    usedAt: null,
    usedWeekId: null,
  };
  const notes = await loadNotes(env);
  notes.push(note);
  await saveNotes(env, notes);
  return json(201, { ok: true, note });
}

async function markNotesUsed(env, ids, weekId) {
  if (!ids?.length) return;
  const set = new Set(ids);
  const notes = await loadNotes(env);
  const usedAt = new Date().toISOString();
  let changed = false;
  for (const note of notes) {
    if (set.has(note.id) && !note.usedAt) {
      note.usedAt = usedAt;
      note.usedWeekId = weekId || null;
      changed = true;
    }
  }
  if (changed) await saveNotes(env, notes);
}

function parseDaySlot(value) {
  const v = String(value || "").trim().toLowerCase();
  const map = {
    monday: "001", mon: "001", "001": "001",
    wednesday: "002", wed: "002", "002": "002",
    friday: "003", fri: "003", "003": "003",
  };
  return map[v] || null;
}

async function photoFromBoard(env, post) {
  if (!post) return null;
  const id = post.customPhoto || post.photo;
  if (!id) return null;
  const pool = await loadPhotoPool(env);
  return pool.find((p) => p.id === id || p.boardPhoto === id) || {
    id,
    label: id,
    origin: post.customPhoto ? "upload" : "manifest",
    boardPhoto: post.photo || id,
    src: null,
  };
}

function thisWeekMonday(now) {
  const day = (now.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - day);
  return monday;
}

async function photoFreshness(env, now = new Date()) {
  const pool = await loadPhotoPool(env);
  const used = (await env.KV.get(PHOTO_USED, "json")) || { items: {} };
  const items = used.items || used;
  const uploads = pool.filter((p) => p.origin === "upload");
  const unusedUploads = uploads.filter((p) => !(items[p.id] && items[p.id].usedAt));
  const notes = await loadNotes(env);
  const lastUploadAt = uploads.reduce((max, p) => (p.createdAt && (!max || p.createdAt > max) ? p.createdAt : max), null);
  const lastNoteAt = notes.reduce((max, n) => (n.createdAt && (!max || n.createdAt > max) ? n.createdAt : max), null);
  const lastActivity = [lastUploadAt, lastNoteAt].filter(Boolean).sort().slice(-1)[0] || null;
  const ageMs = lastActivity ? now.getTime() - Date.parse(lastActivity) : Infinity;
  const stale = !Number.isFinite(ageMs) || ageMs >= ASK_DAYS * 24 * 60 * 60 * 1000;
  const weekStart = thisWeekMonday(now).toISOString();
  const uploadsThisWeek = uploads.filter((p) => p.createdAt && p.createdAt >= weekStart).length;
  const low = unusedUploads.length < LOW_UPLOAD_THRESHOLD;
  return {
    unusedUploads: unusedUploads.length,
    uploadCount: uploads.length,
    lastActivity,
    stale,
    low,
    uploadsThisWeek,
    sundayAsk: low || stale,
    thursdayNudge: low && uploadsThisWeek === 0,
  };
}

async function nudgeForPhotosIfNeeded(env, now = new Date()) {
  const freshness = await photoFreshness(env, now);
  if (!freshness.thursdayNudge) {
    return { skipped: true, reason: "not needed", freshness };
  }
  const weekId = thisWeekMonday(now).toISOString().slice(0, 10);
  const previous = (await env.KV.get(NUDGE_KEY, "json")) || null;
  if (previous && previous.weekId === weekId) {
    return { skipped: true, reason: "already sent this week", freshness };
  }
  const url = boardUrl(env);
  const text = `${PHOTO_NUDGE} ${url}`;
  const notification = await notify(env, { type: "nudge", text, subject: defaultSubject("nudge") });
  const record = { weekId, sentAt: notification.sentAt, boardUrl: url };
  await env.KV.put(NUDGE_KEY, JSON.stringify(record));
  return { skipped: false, notification, freshness };
}

/* —— Notifications —— */

async function notify(env, { type, board, slot, subject, text, ask } = {}) {
  const url = boardUrl(env);
  const sentAt = new Date().toISOString();
  const message = text || buildNotifyText(type, board, slot, url, ask);
  const mailSubject = subject || defaultSubject(type, slot);
  // The board key goes only in the one-off test email body, never in weekly
  // or reminder mail, WhatsApp, logs, or API responses.
  const mailBody = type === "test" ? appendTestEmailExtras(message, env) : message;

  const channels = { email: { sent: false }, whatsapp: { skipped: true } };

  const emails = notifyEmails(env);
  if (emails.length && env.SEND_EMAIL) {
    const results = [];
    for (const to of emails) {
      const result = await sendEmail(env, { to, subject: mailSubject, text: mailBody });
      results.push({ to, ...result });
    }
    channels.email = {
      sent: results.every((r) => r.sent),
      recipients: results.map((r) => ({ to: r.to, sent: r.sent, error: r.error || undefined, messageId: r.messageId || undefined })),
    };
  } else if (!env.SEND_EMAIL) {
    channels.email = { sent: false, error: "SEND_EMAIL binding missing" };
  }

  if (env.CALLMEBOT_APIKEY && env.WHATSAPP_PHONE) {
    channels.whatsapp = await sendWhatsApp(env, message);
  } else {
    channels.whatsapp = { sent: false, skipped: true };
  }

  const record = {
    needsReview: type === "ready" || type === "reminder",
    type,
    boardUrl: url,
    subject: mailSubject,
    sentAt,
    channels: summariseChannels(channels),
  };
  await env.KV.put(NOTIFY_STATE, JSON.stringify(record));
  return { sentAt, subject: mailSubject, channels, boardUrl: url };
}

function summariseChannels(channels) {
  return {
    email: {
      sent: !!channels.email?.sent,
      recipientCount: channels.email?.recipients?.length || 0,
      error: channels.email?.error || undefined,
    },
    whatsapp: { sent: !!channels.whatsapp?.sent, skipped: !!channels.whatsapp?.skipped, error: channels.whatsapp?.error || undefined },
  };
}

function boardUrl(env) {
  return (env.BOARD_URL || DEFAULT_BOARD_URL).replace(/\/+$/, "") + "/";
}

function notifyEmails(env) {
  return String(env.NOTIFY_EMAILS || "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function defaultSubject(type, slot) {
  if (type === "ready") return "This week's 3 On a Roll posts are ready to review";
  if (type === "reminder") return "Today's On a Roll post isn't approved yet";
  if (type === "test") return "[Test] On a Roll posts ready";
  if (type === "nudge") return "On a Roll — a couple of fresh photos would help";
  return "On a Roll posts";
}

function buildNotifyText(type, board, slot, url, ask) {
  if (type === "ready") {
    const lines = ["This week's 3 On a Roll posts are ready to review.", ""];
    for (const item of SLOTS) {
      const post = board && board[item.id];
      const headline = post ? `${post.line1 || ""} ${post.line2 || ""}`.replace(/\s+/g, " ").trim() : "(draft missing)";
      lines.push(`${item.day}: ${headline}`);
    }
    lines.push("", "Review and edit them here:", url);
    if (ask) {
      lines.push("", ask);
    }
    return lines.join("\n");
  }
  if (type === "reminder") {
    const day = slot?.day || "Today's";
    const post = board && slot ? board[slot.id] : null;
    const headline = post ? `${post.line1 || ""} ${post.line2 || ""}`.replace(/\s+/g, " ").trim() : "";
    return [
      "Today's post isn't approved yet – it'll go out at 12:00 as it is unless you edit it.",
      headline ? `${day}: ${headline}` : day,
      "",
      "Review it here:",
      url,
    ].join("\n");
  }
  return ["On a Roll notification.", "", url].join("\n");
}

function appendTestEmailExtras(text, env) {
  const parts = [text];
  const key = env.BOARD_KEY;
  if (key) {
    const unlock = boardUrl(env).replace(/\/+$/, "") + "/#key=" + key;
    parts.push(
      "Your board link",
      "This is a private link that unlocks the board on this device. Don't share it.",
      unlock,
    );
  }
  return parts.join("\n\n") + "\n";
}

async function sendEmail(env, { to, subject, text }) {
  const from = env.NOTIFY_FROM || DEFAULT_FROM;
  try {
    // Prefer the structured Email Service API when the binding supports it.
    const result = await env.SEND_EMAIL.send({
      to,
      from: { email: from, name: "On a Roll Posts" },
      subject,
      text,
    });
    return { sent: true, messageId: result && result.messageId };
  } catch (first) {
    try {
      const { EmailMessage } = await import("cloudflare:email");
      const raw = buildRawEmail({ from, to, subject, text });
      await env.SEND_EMAIL.send(new EmailMessage(from, to, raw));
      return { sent: true };
    } catch (second) {
      console.log(JSON.stringify({
        event: "email_failed",
        error: String(second && second.message || first && first.message || second),
        code: (second && second.code) || (first && first.code) || undefined,
      }));
      return { sent: false, error: String(second && second.message || first && first.message || "send failed") };
    }
  }
}

function buildRawEmail({ from, to, subject, text }) {
  const needsEncode = /[^\x20-\x7E]/.test(subject);
  const subjectHeader = needsEncode
    ? `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`
    : subject;
  return [
    `From: On a Roll Posts <${from}>`,
    `To: ${to}`,
    `Subject: ${subjectHeader}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text.replace(/\n/g, "\r\n"),
  ].join("\r\n");
}

async function sendWhatsApp(env, text) {
  const key = env.CALLMEBOT_APIKEY;
  const phone = String(env.WHATSAPP_PHONE || "").replace(/\s+/g, "");
  if (!key || !phone) return { sent: false, skipped: true };
  try {
    const endpoint = new URL("https://api.callmebot.com/whatsapp.php");
    endpoint.searchParams.set("phone", phone);
    endpoint.searchParams.set("text", text);
    endpoint.searchParams.set("apikey", key);
    const res = await fetch(endpoint.toString(), { method: "GET" });
    if (!res.ok) {
      console.log(JSON.stringify({ event: "whatsapp_failed", status: res.status }));
      return { sent: false, error: `callmebot HTTP ${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.log(JSON.stringify({ event: "whatsapp_failed", error: String(err && err.message || err) }));
    return { sent: false, error: String(err && err.message || err) };
  }
}

async function sendTestNotification(env) {
  const url = boardUrl(env);
  const text = [
    "This is a test of On a Roll post alerts.",
    "",
    "You'll get a message like this on Sundays when the week's three posts are ready to review.",
    "",
    "Review the board:",
    url,
  ].join("\n");
  return notify(env, {
    type: "test",
    subject: "[Test] On a Roll posts ready",
    text,
  });
}

/* —— Weekday reminder and publish attempt —— */

function slotForDate(d) {
  const day = d.getUTCDay(); // 0 Sun ... 1 Mon, 3 Wed, 5 Fri
  if (day === 1) return SLOTS[0];
  if (day === 3) return SLOTS[1];
  if (day === 5) return SLOTS[2];
  return null;
}


/* —— Immediate drafts and the scheduled queue —— */

function isoDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function addUtcDays(d, days) {
  const next = new Date(d.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function mondayFromWeekId(weekId) {
  const [y, m, d] = String(weekId || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

function slotOffset(slotId) {
  if (slotId === "002") return 2;
  if (slotId === "003") return 4;
  return 0;
}

function slotPublishAt(monday, slotId) {
  const at = addUtcDays(monday, slotOffset(slotId));
  at.setUTCHours(12, 0, 0, 0);
  return at;
}

function formatDayLabel(d) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

function firstOpenMonday(now) {
  let monday = thisWeekMonday(now);
  // Current week only if every Mon/Wed/Fri 12:00 UTC slot is still in the future and free.
  const allFuture = SLOTS.every((slot) => slotPublishAt(monday, slot.id).getTime() > now.getTime());
  if (!allFuture) monday = addUtcDays(monday, 7);
  return monday;
}

function weekFriday(monday) {
  return slotPublishAt(monday, "003");
}

async function loadSchedule(env) {
  const data = (await env.KV.get(SCHEDULE_KEY, "json")) || { weeks: [] };
  const repaired = await repairAndStore(env, SCHEDULE_KEY, data);
  const weeks = Array.isArray(repaired) ? repaired : repaired.weeks || [];
  return { weeks: weeks.filter((w) => w && w.weekId), updatedAt: repaired.updatedAt || null };
}

async function saveSchedule(env, schedule) {
  const payload = {
    weeks: (schedule.weeks || []).slice(),
    updatedAt: new Date().toISOString(),
  };
  await env.KV.put(SCHEDULE_KEY, JSON.stringify(payload));
  return payload;
}

function scheduledWeekIds(schedule) {
  return new Set((schedule.weeks || []).map((w) => w.weekId));
}

function nextEmptyWeek(now, schedule) {
  const first = firstOpenMonday(now);
  const capMonday = addUtcDays(first, (QUEUE_WEEKS - 1) * 7);
  const used = scheduledWeekIds(schedule);
  let monday = new Date(first.getTime());
  for (let i = 0; i < QUEUE_WEEKS + 4; i++) {
    const id = isoDate(monday);
    if (monday.getTime() > capMonday.getTime()) break;
    if (!used.has(id)) {
      return { weekId: id, monday, full: false };
    }
    monday = addUtcDays(monday, 7);
  }
  const upcoming = (schedule.weeks || [])
    .map((w) => mondayFromWeekId(w.weekId))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());
  const last = upcoming[upcoming.length - 1] || capMonday;
  return { full: true, weekId: null, monday: null, sortedUntil: formatDayLabel(weekFriday(last)) };
}

function stampDraftDates(board, weekId) {
  if (!board || !weekId) return board;
  const monday = mondayFromWeekId(weekId);
  if (!monday) return board;
  for (const slot of SLOTS) {
    const post = board[slot.id];
    if (!post) continue;
    const when = slotPublishAt(monday, slot.id);
    post.scheduledFor = isoDate(when);
    post.scheduledLabel = formatDayLabel(when);
    post.scheduledWeekId = weekId;
  }
  board.targetWeekId = weekId;
  return board;
}

function boardHasDrafts(board) {
  if (!board) return false;
  return SLOTS.every((slot) => board[slot.id] && String(board[slot.id].line1 || "").trim());
}

function boardAllApproved(board) {
  return boardHasDrafts(board) && SLOTS.every((slot) => board[slot.id].status === "approved");
}

function scheduleSummaryFrom(schedule, now) {
  const next = nextEmptyWeek(now, schedule);
  const weeks = (schedule.weeks || []).map((week) => ({
    weekId: week.weekId,
    scheduledAt: week.scheduledAt,
    days: SLOTS.map((slot) => ({
      slot: slot.id,
      day: slot.day,
      scheduledFor: week[slot.id]?.scheduledFor || null,
      scheduledLabel: week[slot.id]?.scheduledLabel || null,
      status: week[slot.id]?.status || null,
      line1: week[slot.id]?.line1 || null,
      line2: week[slot.id]?.line2 || null,
    })),
  }));
  const last = (schedule.weeks || [])
    .map((w) => mondayFromWeekId(w.weekId))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime())
    .slice(-1)[0];
  return {
    weeks,
    cap: QUEUE_WEEKS,
    full: !!next.full,
    nextWeekId: next.weekId || null,
    sortedUntil: next.full ? (next.sortedUntil || (last ? formatDayLabel(weekFriday(last)) : null)) : (last ? formatDayLabel(weekFriday(last)) : null),
  };
}

async function scheduleSummary(env, now = new Date()) {
  const schedule = await loadSchedule(env);
  return scheduleSummaryFrom(schedule, now);
}

async function scheduledPostForDate(env, now) {
  const slot = slotForDate(now);
  if (!slot) return null;
  const weekId = isoDate(thisWeekMonday(now));
  const schedule = await loadSchedule(env);
  const week = (schedule.weeks || []).find((w) => w.weekId === weekId);
  if (!week || !week[slot.id]) return null;
  return { weekId, slot, post: week[slot.id], schedule, week };
}

async function updateScheduledPost(env, weekId, slotId, post) {
  const schedule = await loadSchedule(env);
  const week = (schedule.weeks || []).find((w) => w.weekId === weekId);
  if (!week) return false;
  week[slotId] = post;
  await saveSchedule(env, schedule);
  return true;
}

async function readDraftLock(env) {
  return (await env.KV.get(DRAFT_LOCK_KEY, "json")) || null;
}

async function acquireDraftLock(env) {
  const now = Date.now();
  const current = await readDraftLock(env);
  if (current && Number(current.until) > now) return { ok: false, until: current.until };
  const token = randomId();
  const until = now + DRAFT_LOCK_MS;
  await env.KV.put(DRAFT_LOCK_KEY, JSON.stringify({ token, until }), { expirationTtl: 120 });
  const confirm = await readDraftLock(env);
  if (!confirm || confirm.token !== token) return { ok: false, until: confirm?.until || until };
  return { ok: true, token, until };
}

async function releaseDraftLock(env, token) {
  const current = await readDraftLock(env);
  if (current && current.token === token) await env.KV.delete(DRAFT_LOCK_KEY);
}

async function ensureDrafts(env, { source = "ensure", now = new Date() } = {}) {
  const schedule = await loadSchedule(env);
  const summary = scheduleSummaryFrom(schedule, now);
  const existing = (await env.KV.get(BOARD_KEY, "json")) || null;

  if (boardAllApproved(existing) && !existing._scheduled) {
    const scheduled = await scheduleApproved(env, now);
    if (scheduled.ok && scheduled.cleared) {
      return ensureDrafts(env, { source, now });
    }
  }

  if (boardHasDrafts(existing) && !existing._scheduled) {
    const target = existing.targetWeekId || nextEmptyWeek(now, schedule).weekId;
    stampDraftDates(existing, target);
    return {
      ok: true,
      generated: false,
      reason: "existing-drafts",
      board: existing,
      schedule: summary,
      queueFull: !!summary.full,
    };
  }

  if (summary.full) {
    return {
      ok: true,
      generated: false,
      reason: "queue-full",
      board: { updatedAt: existing?.updatedAt || null },
      schedule: summary,
      queueFull: true,
    };
  }

  const lock = await acquireDraftLock(env);
  if (!lock.ok) {
    return { ok: true, pending: true, reason: "locked", schedule: summary, queueFull: !!summary.full };
  }

  try {
    const again = (await env.KV.get(BOARD_KEY, "json")) || null;
    if (boardHasDrafts(again) && !again._scheduled) {
      const target = again.targetWeekId || nextEmptyWeek(now, schedule).weekId;
      stampDraftDates(again, target);
      return {
        ok: true,
        generated: false,
        reason: "existing-drafts",
        board: again,
        schedule: scheduleSummaryFrom(await loadSchedule(env), now),
        queueFull: false,
      };
    }
    const latestSchedule = await loadSchedule(env);
    const next = nextEmptyWeek(now, latestSchedule);
    if (next.full) {
      const fullSummary = scheduleSummaryFrom(latestSchedule, now);
      return {
        ok: true,
        generated: false,
        reason: "queue-full",
        board: { updatedAt: null },
        schedule: fullSummary,
        queueFull: true,
      };
    }
    const result = await generateWeek(env, { source, notify: false, now, weekId: next.weekId });
    stampDraftDates(result.board, next.weekId);
    result.board.targetWeekId = next.weekId;
    await env.KV.put(BOARD_KEY, JSON.stringify(result.board));
    return {
      ok: true,
      generated: true,
      reason: "generated",
      board: result.board,
      copySource: result.copySource,
      weekId: next.weekId,
      schedule: scheduleSummaryFrom(latestSchedule, now),
      queueFull: false,
      freshness: result.freshness,
      notification: null,
    };
  } finally {
    await releaseDraftLock(env, lock.token);
  }
}

async function sundayEnsureDrafts(env, now = new Date()) {
  const result = await ensureDrafts(env, { source: "cron", now });
  // If another request holds the lock, a later page load will finish the set.
  if (result.pending) return result;
  const comingMonday = isoDate(firstOpenMonday(now));
  const board = result.board || {};
  const draftsNeedReview = boardHasDrafts(board) && !boardAllApproved(board) && !board._scheduled;
  const schedule = await loadSchedule(env);
  const coming = (schedule.weeks || []).find((w) => w.weekId === comingMonday);
  const scheduledNeedReview = !!(coming && SLOTS.some((slot) => coming[slot.id] && coming[slot.id].status !== "approved" && coming[slot.id].status !== "publish-pending"));
  if (draftsNeedReview || scheduledNeedReview) {
    const notifyBoard = draftsNeedReview ? board : coming;
    result.notification = await notify(env, {
      type: "ready",
      board: notifyBoard,
      ask: result.freshness?.sundayAsk ? `${PHOTO_ASK} ${boardUrl(env)}` : null,
    });
  }
  return result;
}

async function scheduleApproved(env, now = new Date(), incoming = null) {
  let board = (await env.KV.get(BOARD_KEY, "json")) || null;
  const clientBoard = incoming && typeof incoming === "object" && !Array.isArray(incoming)
    ? (incoming.board && typeof incoming.board === "object" ? incoming.board : incoming)
    : null;
  if (!boardAllApproved(board) && boardAllApproved(clientBoard)) {
    board = { ...(board || {}), ...clientBoard };
  }
  if (!boardHasDrafts(board)) {
    return { ok: false, error: "no_drafts", schedule: await scheduleSummary(env, now) };
  }
  if (!boardAllApproved(board)) {
    return { ok: false, error: "not_all_approved", board, schedule: await scheduleSummary(env, now) };
  }
  const schedule = await loadSchedule(env);
  const next = nextEmptyWeek(now, schedule);
  if (next.full) {
    return { ok: false, error: "queue_full", schedule: scheduleSummaryFrom(schedule, now), queueFull: true };
  }
  const already = (schedule.weeks || []).find((w) => w.weekId === (board.scheduledWeekId || board.targetWeekId) && SLOTS.every((s) => w[s.id]?.line1 === board[s.id]?.line1));
  if (already) {
    return { ok: true, already: true, weekId: already.weekId, week: already, schedule: scheduleSummaryFrom(schedule, now), cleared: false };
  }
  const weekId = next.weekId;
  const monday = next.monday;
  const week = {
    weekId,
    scheduledAt: new Date().toISOString(),
  };
  for (const slot of SLOTS) {
    const when = slotPublishAt(monday, slot.id);
    week[slot.id] = {
      ...board[slot.id],
      status: "approved",
      scheduledFor: isoDate(when),
      scheduledLabel: formatDayLabel(when),
      scheduledWeekId: weekId,
    };
  }
  schedule.weeks = [...(schedule.weeks || []).filter((w) => w.weekId !== weekId), week];
  await saveSchedule(env, schedule);
  // Clear the draft board so the next page load can write a fresh set.
  await env.KV.delete(BOARD_KEY);
  await env.KV.delete(DRAFT_LOCK_KEY);
  return {
    ok: true,
    weekId,
    week,
    board: { updatedAt: null, _scheduled: true, scheduledWeekId: weekId },
    cleared: true,
    schedule: scheduleSummaryFrom(schedule, now),
    posts: Object.fromEntries(SLOTS.map((slot) => [slot.id, week[slot.id]])),
  };
}

async function remindIfNeeded(env, now) {
  const slot = slotForDate(now);
  if (!slot) return { skipped: true, reason: "not a posting day" };
  const found = await scheduledPostForDate(env, now);
  if (!found) return { skipped: true, reason: "no scheduled post" };
  const post = found.post;
  if (post.status === "approved" || post.status === "publish-pending") {
    return { skipped: true, reason: `status is ${post.status}` };
  }
  const board = { [slot.id]: post, weekId: found.weekId };
  const notification = await notify(env, { type: "reminder", board, slot });
  return { ok: true, slot: slot.id, day: slot.day, weekId: found.weekId, notification };
}

async function publishDue(env, now) {
  const slot = slotForDate(now);
  if (!slot) return { skipped: true, reason: "not a posting day" };
  const found = await scheduledPostForDate(env, now);
  if (!found) return { skipped: true, reason: "no scheduled post" };
  const post = found.post;
  post.dueToPublish = true;
  post.dueAt = new Date().toISOString();

  const attempts = {
    facebook: publishPlaceholder("facebook"),
    instagram: publishPlaceholder("instagram"),
  };
  console.log(JSON.stringify({
    event: "publish_attempt",
    slot: slot.id,
    day: slot.day,
    weekId: found.weekId,
    status: post.status,
    facebook: attempts.facebook,
    instagram: attempts.instagram,
  }));

  // 501 until Meta is connected — mark the post and do not error the cron.
  post.status = "publish-pending";
  post.publishNote = "Meta not connected";
  await updateScheduledPost(env, found.weekId, slot.id, post);
  return {
    ok: true,
    slot: slot.id,
    day: slot.day,
    weekId: found.weekId,
    status: post.status,
    publishNote: post.publishNote,
    attempts,
  };
}
