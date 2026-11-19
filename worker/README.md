# onaroll-posts

Cloudflare Worker that stores Jon’s On a Roll social board so it can sync
between devices, keep a photo library that is not capped by `localStorage`,
and archive an approved week without downloading two files and pushing them
to GitHub.

Live URL (workers.dev):

```
https://onaroll-posts.dent-pete.workers.dev
```

The public GitHub Pages app is https://four2d.github.io/onaroll-garage-doors/.
This Worker does not serve that page. Wire the board up to these endpoints in
a later change — do not point `wrangler deploy` at `index.html`.

## Storage

- **KV** namespace `onaroll-posts` (binding `KV`) holds:
  - the current week’s board JSON
  - photo binaries and metadata
  - archived weeks
- **R2 was not used.** Listing R2 buckets on this account returns “Please
  enable R2 through the Cloudflare Dashboard.” Enabling it can require a
  payment method, and this project stays on the free plan. Photos are stored
  as binary KV values, capped at **4 MiB** each (well under the 25 MiB KV
  value limit). The existing board already compresses uploads to JPEG at a
  max edge of 1600px — keep doing that before `POST /photos`.

## Auth

Every write, every board read, photo listing, and archive read needs the
header:

```
X-Board-Key: <BOARD_KEY>
```

`BOARD_KEY` is a Worker secret. It is not in this repo. On the ops box it is
kept at `/home/box/.secrets/onaroll-board.env` as `ONAROLL_BOARD_KEY`.

`GET /photos/:id` is public (unguessable ids) so Instagram can later fetch a
HTTPS image URL.

`GET /` is a no-auth health check: `{ ok, name, storage }`.

## CORS

Allowed origins:

- `https://four2d.github.io`
- `http://localhost` and `http://127.0.0.1` (any port, for local testing)

Preflight (`OPTIONS`) is handled on every route. Other origins get no CORS
headers.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | no | Health check |
| `GET` | `/board` | yes | Current week board JSON |
| `PUT` | `/board` | yes | Replace the current week board (optimistic lock) |
| `GET` | `/photos` | yes | Photo library, newest first |
| `POST` | `/photos` | yes | Upload an image; returns `{ id, url }` |
| `GET` | `/photos/:id` | no | Serve the image |
| `DELETE` | `/photos/:id` | yes | Delete a photo |
| `GET` | `/archive` | yes | List archived weeks, newest first |
| `POST` | `/archive` | yes | Save an approved week |
| `GET` | `/archive/:id` | yes | One archived week |
| `POST` | `/publish/facebook` | yes | Placeholder — `501` “Meta not connected yet” |
| `POST` | `/publish/instagram` | yes | Placeholder — `501` “Meta not connected yet” |

### Board sync (`GET` / `PUT /board`)

The body is the whole board object the client already keeps in
`localStorage` (`oar-jon-board-v26`), plus an `updatedAt` ISO timestamp
managed by the Worker.

- `GET` on an empty store returns `{ "updatedAt": null }`.
- `PUT` must tell the Worker which version the client last saw, as one of:
  - header `X-Board-Base: <updatedAt>`
  - header `If-Match: <updatedAt>`
  - body field `baseUpdatedAt`
  - body field `updatedAt` (the value from the last GET/PUT, not a new time)
- If the store already has a board and the base does not match the current
  `updatedAt`, the Worker returns **409** with `{ error: "conflict", current }`
  so the client can merge and retry.
- On success the Worker writes a fresh `updatedAt` and returns the saved
  board. Use that value as the base for the next `PUT`.
- The first write (no board stored yet) does not need a base.

This is last-write-wins with an optimistic check, not a CRDT. The client
should merge post-by-post when it sees a 409.

### Photos (`POST /photos`)

Accepted bodies:

- `multipart/form-data` with a `file`, `photo`, or `image` field
- raw `image/*` body
- JSON `{ "dataUrl": "data:image/jpeg;base64,..." }` or `{ "base64", "contentType" }`

Response `201`:

```json
{ "id": "…", "url": "https://onaroll-posts.dent-pete.workers.dev/photos/…", "contentType": "image/jpeg", "size": 12345, "createdAt": "…" }
```

Ids are 16 random bytes, hex-encoded. The `url` is a public HTTPS image URL,
which later Instagram publishing will need.

`GET /photos` returns `{ "photos": [ { id, url, contentType, size, createdAt, filename } ] }`, newest first.

### Archive (`POST /archive`)

Replaces the “download `YYYY-MM-DD.html` + `weeks.json` and push to GitHub”
step. Send the week meta and each post, including the baked Facebook image as
a data URL (or a photo id already returned by `POST /photos`):

```json
{
  "id": "2026-11-16",
  "label": "Week of 16 Nov 2026",
  "postedAt": "2026-11-19",
  "file": "2026-11-16.html",
  "html": "<!DOCTYPE html>…",
  "posts": [
    {
      "id": "001",
      "day": "Monday",
      "line1": "…",
      "line2": "…",
      "caption": "…",
      "fbDataUrl": "data:image/jpeg;base64,…"
    }
  ]
}
```

`id` is optional; the Worker will use the UTC Monday of today if it is
omitted. Data URLs are stored as photos and replaced with `fbPhotoId` +
`fbUrl` on the saved week so the archive JSON stays small. Re-posting the
same `id` overwrites that week.

`GET /archive` returns `{ "weeks": [ { id, label, postedAt, file, postCount, createdAt, updatedAt } ] }`.

`GET /archive/:id` returns the full week, including `html` if you sent it.

### Publish placeholders

`POST /publish/facebook` and `POST /publish/instagram` always return:

```json
{ "error": "Meta not connected yet" }
```

with status **501**. They are shaped so a Page token and Instagram business
account id can later be added as Worker secrets (`META_PAGE_TOKEN`,
`META_PAGE_ID`, `META_IG_USER_ID`) without changing the URL scheme. Do not
put those values in this repo.

## Setup

From this `worker/` directory, with Wrangler logged into the Pete Cloudflare
account (`7e2fd6cc6c830ed939df10ccc0d2cb6c`):

```bash
npx wrangler@4 deploy
npx wrangler@4 secret put BOARD_KEY
# later, once a Page admin can create a Meta app:
# npx wrangler@4 secret put META_PAGE_TOKEN
# npx wrangler@4 secret put META_PAGE_ID
# npx wrangler@4 secret put META_IG_USER_ID
```

The KV namespace id in `wrangler.toml` already exists. Do not recreate it,
and do not modify `foxon-books-ch`, `foxon-forms`, `foxon-stats`, or
`invoicr-relay`.

Local dev:

```bash
# put BOARD_KEY=… in worker/.dev.vars (gitignored)
npx wrangler@4 dev
```

Then call `http://localhost:8787` with the same `X-Board-Key` header.

## Free plan

This Worker and its KV namespace are meant to stay on the free plan: no R2,
no paid add-ons. KV has a daily write cap, so prefer updating the board in
batches rather than on every keystroke, and keep photo uploads compressed.
