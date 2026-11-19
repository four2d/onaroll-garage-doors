/**
 * On a Roll social board — sync, photo library, and week archive.
 *
 * Storage: Workers KV (R2 is not enabled on this account). Photos are stored
 * as binary values, capped well under the KV value limit. The client should
 * compress uploads (the existing board already resizes to JPEG) before POST.
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
};

async function route(request, env, path) {
  const method = request.method.toUpperCase();

  if (path === "/" && method === "GET") {
    return json(200, {
      ok: true,
      name: "onaroll-posts",
      storage: "kv",
    });
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
    return methodNotAllowed("GET, PUT");
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

  if (path === "/publish/facebook" || path === "/publish/instagram") {
    if (method !== "POST") return methodNotAllowed("POST");
    await requireKey(request, env);
    // Placeholders only. Later these will use:
    //   env.META_PAGE_TOKEN, env.META_PAGE_ID, env.META_IG_USER_ID
    // Instagram needs a public image URL from GET /photos/:id.
    return json(501, { error: "Meta not connected yet" });
  }

  return json(404, { error: "not found" });
}

/* —— Board —— */

async function getBoard(env) {
  const board = await env.KV.get(BOARD_KEY, "json");
  if (!board) return json(200, { updatedAt: null });
  return json(200, board);
}

async function putBoard(request, env) {
  const body = await readJson(request, MAX_JSON_BYTES);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(400, { error: "board must be a JSON object" });
  }

  const incoming = { ...body };
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
          current: existing,
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
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/* —— Auth & CORS —— */

async function requireKey(request, env) {
  const expected = env.BOARD_KEY;
  if (!expected) {
    const err = new Error("server not configured");
    err.status = 500;
    throw err;
  }
  const provided = request.headers.get("X-Board-Key") || "";
  const ok = await keysMatch(provided, expected);
  if (!ok) {
    const err = new Error("unauthorized");
    err.status = 401;
    throw err;
  }
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
    "Access-Control-Allow-Headers": "Content-Type, X-Board-Key, X-Board-Base, If-Match",
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
