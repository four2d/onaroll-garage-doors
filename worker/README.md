# onaroll-posts

Cloudflare Worker that stores Jon’s On a Roll social board so it can sync
between devices, keep a photo library that is not capped by `localStorage`,
archive an approved week without downloading two files and pushing them
to GitHub, and generate next week's three drafts every Sunday.

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
| `DELETE` | `/board` | yes | Clear the current week board |
| `GET` | `/photos` | yes | Photo library, newest first |
| `POST` | `/photos` | yes | Upload an image; returns `{ id, url }` |
| `GET` | `/photos/:id` | no | Serve the image |
| `DELETE` | `/photos/:id` | yes | Delete a photo |
| `GET` | `/archive` | yes | List archived weeks, newest first |
| `POST` | `/archive` | yes | Save an approved week |
| `GET` | `/archive/:id` | yes | One archived week |
| `POST` | `/publish/facebook` | yes | Placeholder — `501` “Meta not connected yet” |
| `POST` | `/publish/instagram` | yes | Placeholder — `501` “Meta not connected yet” |
| `POST` | `/publish` | yes | Same Meta placeholder used by the 12:00 cron |
| `POST` | `/generate` | yes | Build next week's three awaiting drafts and notify |
| `POST` | `/notify/test` | yes | Send a one-off test email (and WhatsApp, if configured) |

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


### Weekly drafts (`POST /generate` and Sunday 18:00 UTC)

A Cron Trigger at **Sunday 18:00 UTC** builds Monday, Wednesday and Friday
drafts for the coming week, all with `status: "awaiting"`. The same job is
exposed as `POST /generate` (requires `X-Board-Key`). Send
`{ "notify": false }` to generate without emailing or pushing.

Each post matches the board object on `jonbot/phase1-fixes`: `line1`, `line2`,
`sub`, `cta`, `caption`, `photo`, `status`, `showPrice: false`, `priceFrom`,
`priceAmount` (empty) and `customPhoto`.

**Photos** are picked from the public manifest at
`https://four2d.github.io/onaroll-garage-doors/photos/manifest.json` (mostly
exports from Jon's Facebook page) plus anything uploaded to `POST /photos`.
A used-photo log in KV avoids repeats until the pool is exhausted, then
reuses the least recently used photo.

**Copy** is written with Workers AI on the free Neuron allocation, trying
`@cf/zai-org/glm-4.7-flash` first (strong JSON-friendly model on the free
tier) and falling back to `@cf/meta/llama-4-scout-17b-16e-instruct`. Brand
rules:

- local, honest voice for a family-run garage door fitter in Poole
- vary the angle: a recent install, a security or insulation benefit, and a free survey call
- no prices at all
- no founding years or “since …”
- no reviews, testimonials, star ratings or accreditations
- warranty may only be “5-year warranty”
- CTA “Free survey · 01202 553603”, WhatsApp 07534 066813 and onarollgaragedoors.co.uk
- hashtags for Poole, Bournemouth, Christchurch and Dorset

Every draft is run through a validator that rejects `£`, digits followed by
“year” other than “5-year”, “since”, “review”, “star”, “guarantee” /
“guaranteed”, “best”, “cheapest”, “No.1” and other superlatives or salesy
claims, Title Case headlines, lines that end mid-phrase (for example “great for.”), and lines that are over length (`line1`/`line2`
42, `sub` 110, `caption` 2200). Headlines are punctuated so they join
cleanly into the caption. If the model fails twice, the Worker uses
template copy.

### Notifications

After a Sunday generate, `notify()` tells Pete (and later Jon) that the
posts are ready. Recipients come from the Worker var `NOTIFY_EMAILS`
(currently `dent.pete@gmail.com`; add Jon’s address later). The email is
sent with the `SEND_EMAIL` binding, from `onaroll-posts@foxonsoftware.com`,
and never includes the board key. The Sunday message is “This week's 3 On a
Roll posts are ready to review”, with a one-line summary of each post
(day and headline) and a link to
https://four2d.github.io/onaroll-garage-doors/.

WhatsApp uses the free [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/)
API. The phone number is the Worker var `WHATSAPP_PHONE` (`+447854046904`).
The API key is the Worker secret `CALLMEBOT_APIKEY`. If that secret is not
set, WhatsApp is skipped quietly. To activate it, Pete should message
CallMeBot from WhatsApp to receive a key, then:

```bash
npx wrangler@4 secret put CALLMEBOT_APIKEY
```

The same short ready/reminder text, including the board link, is used on
email and WhatsApp.

### Remind, then post (Mon / Wed / Fri)

- **08:00 UTC** — if that day's post is still not `approved`, send a
  reminder through the same channels: “Today's post isn't approved yet –
  it'll go out at 12:00 as it is unless you edit it.”
- **12:00 UTC** — mark the day's post as due-to-publish and call
  `/publish`. That returns `501` until Meta is connected, so the Worker
  logs the attempt and sets the post status to `publish-pending` with
  `publishNote: "Meta not connected"`, without erroring the cron.

`POST /notify/test` sends one test email with the subject
`[Test] On a Roll posts ready`. That email is the only place that includes
a private board unlock link (the page reads `#key=` from the hash, saves
it on the device, then strips it). It is a private link and should not be
shared. Weekly and reminder emails use the plain board URL only and never
include the key.
It does not send a WhatsApp test.

## Setup

From this `worker/` directory, with Wrangler logged into the Pete Cloudflare
account (`7e2fd6cc6c830ed939df10ccc0d2cb6c`):

```bash
npx wrangler@4 deploy
npx wrangler@4 secret put BOARD_KEY
# once CallMeBot has issued a key:
# npx wrangler@4 secret put CALLMEBOT_APIKEY
# later, once a Page admin can create a Meta app:
# npx wrangler@4 secret put META_PAGE_TOKEN
# npx wrangler@4 secret put META_PAGE_ID
# npx wrangler@4 secret put META_IG_USER_ID
```

To add Jon to the email list later, append his address to `NOTIFY_EMAILS`
and add him as a verified Email Routing destination, then allow that
address on the `SEND_EMAIL` binding.

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
