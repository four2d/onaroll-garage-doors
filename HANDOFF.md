# On a Roll social post tool — handoff

Last updated: 19 Nov 2026 (Europe/London). Work on this tool is paused until Pete says otherwise.

## What it is

A small tool for Jon (On a Roll Garage Doors, Poole) to review and approve three social posts a week, for Facebook and Instagram, with as little input from him as possible.

The public page is https://four2d.github.io/onaroll-garage-doors/. It opens on a simple phone view: “Your 3 posts”, with Looks good, Try another, Change photo, Edit words, and Add a job photo. The original full editor is behind Advanced editor.

Opening the page writes three drafts if none are waiting. Once all three are approved they are booked into the next empty Monday / Wednesday / Friday week (up to four weeks ahead). The next visit then writes a fresh set. If the queue is full, the page says “You're sorted until &lt;date&gt;”.

Facebook and Instagram publishing is not connected yet. It waits on a Page admin invite from Jon.

## Architecture

- **Frontend:** a single-file `index.html` (inline CSS and JS) on GitHub Pages, repo [four2d/onaroll-garage-doors](https://github.com/four2d/onaroll-garage-doors), branch `main`. Photos also live in `photos/` with a `manifest.json`.
- **Backend:** Cloudflare Worker `onaroll-posts` at https://onaroll-posts.dent-pete.workers.dev
  - Account: `7e2fd6cc6c830ed939df10ccc0d2cb6c` (workers.dev subdomain `dent-pete`)
  - KV namespace `onaroll-posts`, id `7fa483e1737841b3b642d01293402879`
  - Bindings: KV, Workers AI, `SEND_EMAIL`
  - Vars: `NOTIFY_EMAILS`, `NOTIFY_FROM`, `BOARD_URL`, `WHATSAPP_PHONE`
- **Copy:** Workers AI (tries `@cf/zai-org/glm-4.7-flash`, then `@cf/meta/llama-4-scout-17b-16e-instruct`) with a validator and template fallback. GLM must be called with `chat_template_kwargs: { enable_thinking: false }` or it returns empty content.
- **Other FOXON Workers** on the same account (`foxon-books-ch`, `foxon-forms`, `foxon-stats`, `invoicr-relay`) must be left untouched.

State is stored in KV (`board:current`, `schedule:weeks`, `history:weeks`, `notes:inbox`, photo index and binaries, sessions, sign-in codes). The frontend also keeps a local copy in `localStorage` (`oar-jon-board-v27`) and syncs with an optimistic lock (`X-Board-Base` / 409 merge).

**Known limit:** R2 is not enabled on this account (it may need a card). Photos are stored as binary KV values, capped at 4 MiB.

## Auth

Protected routes accept either:

- the original **board key**, as `X-Board-Key` (also still works via a `#key=` link, which is saved on the device and then stripped from the URL), or
- a **device session token**, also sent as `X-Board-Key` (or `X-Board-Session`). Sessions last 180 days, live in KV, and are revocable.

Login never returns the board key.

The usual sign-in is:

1. `POST /auth/request` with `{ "contact" }` — email or a UK mobile (`07…`, `+44`, spaces are fine).
2. Only allowlisted contacts get a 6-digit code (10 minutes, single use, 5 guesses) plus a one-tap `#login=` link. Email uses the mail binding; a phone uses CallMeBot WhatsApp.
3. Everyone else still gets `{ ok: true, message: "If that's registered, a code is on its way" }`.
4. `POST /auth/verify` with `{ "contact", "code" }` or `{ "login" }` returns `{ session, expiresAt }`.
5. The page stores the session in `localStorage` (`oar-jon-session`) and that browser stays signed in.

Allowlist today: Worker vars `NOTIFY_EMAILS` (Pete: `dent.pete@gmail.com`) and `WHATSAPP_PHONE` (Pete). Jon is added later.

Rate limits: 3 sends per 15 minutes per contact, 10 per hour per IP. “Have a board code?” remains as a small fallback on the lock screen.

A test-only hook exists: if the optional secret `AUTH_TEST_HOOK` is set and the request has a matching `X-Auth-Test` header, no email or WhatsApp is sent and the JSON includes `devCode` / `devLogin` for Playwright. Do not expose that hook to the public page.

## API

All writes, board reads, photo listing and archive reads need a valid `X-Board-Key` (board key or session), except where marked **no**.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | no | Health check, includes a `typography` UTF-8 check string |
| `POST` | `/auth/request` | no | Send a sign-in code and magic link if allowlisted |
| `POST` | `/auth/verify` | no | Exchange a code or `#login=` ticket for a session |
| `GET` | `/auth/delivery-status` | yes | Last sign-in delivery result, without the code |
| `GET` | `/board` | yes | Current draft set |
| `PUT` | `/board` | yes | Replace the draft set (optimistic lock) |
| `DELETE` | `/board` | yes | Clear the draft set and generate lock. Does not clear the schedule, photos or notes |
| `GET` | `/photos` | yes | Photo library, newest first |
| `POST` | `/photos` | yes | Upload an image; returns `{ id, url }` |
| `GET` | `/photos/:id` | no | Serve the image (unguessable ids) |
| `DELETE` | `/photos/:id` | yes | Delete a photo |
| `GET` | `/archive` | yes | List archived weeks |
| `POST` | `/archive` | yes | Save an approved week |
| `GET` | `/archive/:id` | yes | One archived week |
| `POST` | `/generate` | yes | Force-build three drafts. `{ "notify": false }` skips email/WhatsApp |
| `POST` | `/ensure-drafts` | yes | Return the current unapproved set, or write one if none is waiting (never notifies). `202` if another generate is in flight |
| `GET` | `/schedule` | yes | List scheduled Mon/Wed/Fri weeks and the 4-week cap |
| `POST` | `/schedule` or `/schedule-approved` | yes | Move a fully approved draft set into the next empty week |
| `DELETE` | `/schedule` | yes | Clear the scheduled queue |
| `POST` | `/regenerate/:day` | yes | Rewrite one day (`monday`, `wednesday` or `friday`). Keep the photo unless `?photo=new` |
| `GET` | `/notes` | yes | Inspiration notes, unused first |
| `POST` | `/notes` | yes | Add a note (`{ "text", "photoIds"? }`) |
| `POST` | `/notify/test` | yes | One-off test email (and WhatsApp if configured). This is the only mail that includes the private `#key=` board link |
| `POST` | `/publish/facebook` | yes | Placeholder — `501` “Meta not connected yet” |
| `POST` | `/publish/instagram` | yes | Placeholder — `501` “Meta not connected yet” |
| `POST` | `/publish` | yes | Same Meta placeholder used by the 12:00 cron |

`POST /ensure-drafts` is race-safe (KV lock). The current week is used for scheduling only if all three 12:00 UTC slots are still in the future and free; otherwise the next empty week is used.

## Crons (UTC)

| Cron | When | What |
|------|------|------|
| `0 18 * * SUN` | Sunday 18:00 | Make sure a draft set exists. Email/WhatsApp the review message only if something still needs reviewing for the coming week. May add a “running low on fresh photos” ask |
| `0 8 * * MON,WED,FRI` | 08:00 on posting days | If today's **scheduled** post is not approved, send a reminder |
| `0 12 * * MON,WED,FRI` | 12:00 on posting days | Mark today's scheduled post due-to-publish and call `/publish`. Until Meta is connected this logs the attempt and sets `publish-pending` / “Meta not connected”, without failing the cron |
| `0 17 * * THU` | Thursday 17:00 | At most one photo nudge, only if unused uploads are low and there were no uploads that week |

## Generation, freshness, validator and brand

- Three angles per set from a wider pool: recent install, before-and-after, security, insulation or quiet running, a seasonal hook, a rotating local-area spotlight (Poole, Bournemouth, Christchurch, Wimborne, Ferndown, Broadstone, Wareham, Swanage), family-run / behind the scenes, how a free survey works, a maintenance tip, colours and finishes.
- Last **eight weeks** of headlines and angles are stored in `history:weeks` and are not reused until they age out.
- Photos prefer Jon's unused uploads, then unused library photos, then the least recently used. Unused inspiration notes are used first and then marked used.
- Local, honest voice for a family-run garage door fitter in Poole.
- No invented prices, reviews, jobs or locations. A local-area spotlight may say they cover a town; it must not claim a job there unless a note or photo label says so.
- No founding years or “since …”. Warranty may only be “5-year warranty”.
- No `£` in generated copy, no superlatives (“best”, “cheapest”, “No.1”), no “review” / “star” / “guarantee”.
- No driveway / resin / paving wording (wrong trade).
- No DIY advice about springs, cables or tension. Maintenance copy should be “spot the signs, then call us”.
- Headlines are sentence case, not Title Case, and start with a capital letter. Incomplete endings such as “Just finished a job in.” are rejected.
- Length caps: `line1`/`line2` 42, `sub` 110, `caption` 2200.
- If the model fails twice, template copy is used.
- A repair pass on board, schedule, history, notes and archive fixes typographic mojibake (`â` → `—`, `Â·` → `·`, and so on) in place, without clearing drafts.

## Notifications

- **Email:** `SEND_EMAIL` binding via foxonsoftware.com Email Routing. From `onaroll-posts@foxonsoftware.com`. Pete (`dent.pete@gmail.com`) is a verified destination. Add Jon later.
- **WhatsApp:** free [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/) API. Number is the Worker var `WHATSAPP_PHONE`. Key is the Worker secret `CALLMEBOT_APIKEY`. If that secret is missing, WhatsApp is skipped. Jon will need his own CallMeBot activation before his number is added.
- Weekly / reminder / nudge mail uses the plain board URL and never includes the board key. Only `POST /notify/test` includes the private `#key=` link.
- Sign-in codes go only to the allowlisted contact that was entered.

## Secrets (names only)

Never paste values into chat, the repo, or memory.

| Secret | Where it lives | Used for |
|--------|----------------|----------|
| `BOARD_KEY` | Worker secret. On the ops box: `/home/box/.secrets/onaroll-board.env` as `ONAROLL_BOARD_KEY` | Legacy board code / `#key=` link |
| `CALLMEBOT_APIKEY` | Worker secret. Box env: `ONAROLL_CALLMEBOT_APIKEY` | WhatsApp sends |
| `AUTH_TEST_HOOK` | Worker secret. Box env: `ONAROLL_AUTH_TEST_HOOK` | Playwright header `X-Auth-Test` so tests do not send real mail or WhatsApp |
| `META_PAGE_TOKEN` | Not set yet | Facebook Page access token |
| `META_PAGE_ID` | Not set yet | Facebook Page id |
| `META_IG_USER_ID` | Not set yet | Instagram business account id |

Non-secret vars (already in `worker/wrangler.toml`): `NOTIFY_EMAILS`, `NOTIFY_FROM`, `BOARD_URL`, `WHATSAPP_PHONE`.

The box env file is mode `600`. A deploy that uploads the Worker script **without** re-putting secrets can wipe the existing Worker secrets — always re-put `BOARD_KEY`, `CALLMEBOT_APIKEY` and `AUTH_TEST_HOOK` after a script upload that does not include them.

## How to deploy

Preferred: from `worker/`, with Wrangler logged into Pete's Cloudflare account:

```bash
npx wrangler@4 deploy
npx wrangler@4 secret put BOARD_KEY
npx wrangler@4 secret put CALLMEBOT_APIKEY
npx wrangler@4 secret put AUTH_TEST_HOOK
```

If you deploy via the Cloudflare API / MCP `execute` helper, **do not** put the source through plain `atob()` and then a `Blob`. `atob` returns a Latin-1 binary string, and the Blob re-encodes typographic characters as mojibake (`—` → `â`, `·` → `Â·`). Decode the bytes as UTF-8 first:

```javascript
const script = new TextDecoder("utf-8").decode(
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
);
```

`scripts/build-cf-deploy.mjs` builds that execute function from `worker/src/index.js`. After any such deploy, re-put the three secrets. Check `GET /` — the `typography` field must be exactly `— · ’ “” £ →`.

Do not touch the other FOXON Workers on the account.

## How to test

Secrets for tests come from the environment (or the box env file). Never hard-code them.

```bash
# Validator unit tests (no network)
node tests/test-validator.mjs

# Playwright against the live Worker, 390×844, serving local index.html
cd tests/playwright
npm install
# source the env file if you are on the ops box, then:
npx playwright install chromium   # once
node simple-view.spec.mjs
node ready-now.spec.mjs           # can generate and schedule; read the file first
node mojibake.spec.mjs            # set OAR_RESTORE_BOARD if you need the live board restored
node code-login.spec.mjs          # needs ONAROLL_AUTH_TEST_HOOK; does not send real mail
```

`code-login` intercepts `/auth/request` and adds `X-Auth-Test`, so no real WhatsApp or email goes out. Do not clear Pete's live drafts unless a test is written to restore them. `ready-now.spec.mjs` historically cleared the board and schedule — only run it if that is intended.

CORS allows `https://four2d.github.io` and `http://localhost` / `http://127.0.0.1` (any port). Python-urllib's default User-Agent can be Cloudflare 1010-banned; use curl or Playwright with a normal UA.

## PR history (all 19 Nov 2026, Europe/London)

| PR | Title | Branch |
|----|-------|--------|
| [#1](https://github.com/four2d/onaroll-garage-doors/pull/1) | Phase 1: job-led posts, prices off by default, no 2014 line | `jonbot/phase1-fixes` |
| [#2](https://github.com/four2d/onaroll-garage-doors/pull/2) | Sync + archive backend (Cloudflare Worker) | `jonbot/sync-worker` |
| [#3](https://github.com/four2d/onaroll-garage-doors/pull/3) | Sync the board with the Cloudflare Worker | `jonbot/sync-frontend` |
| [#4](https://github.com/four2d/onaroll-garage-doors/pull/4) | Add a simple phone view for Jon, keep the full editor as Advanced | `jonbot/simple-view` |
| [#5](https://github.com/four2d/onaroll-garage-doors/pull/5) | Keep weekly posts fresh with notes, angles, and regenerate | `jonbot/fresh-posts` |
| [#6](https://github.com/four2d/onaroll-garage-doors/pull/6) | Wire Try another and Change photo, and tighten copy | `jonbot/try-another` |
| [#7](https://github.com/four2d/onaroll-garage-doors/pull/7) | Ban unsafe spring advice and driveway wording, and capitalise copy | `jonbot/safer-copy` |
| [#8](https://github.com/four2d/onaroll-garage-doors/pull/8) | Keep Looks good approved on a second tap, and make loading obvious | `jonbot/approve-fix` |
| [#9](https://github.com/four2d/onaroll-garage-doors/pull/9) | Write posts as soon as the board opens | `jonbot/ready-now` |
| [#10](https://github.com/four2d/onaroll-garage-doors/pull/10) | Fix garbled dashes and dots in captions | `jonbot/fix-mojibake` |
| [#11](https://github.com/four2d/onaroll-garage-doors/pull/11) | Sign in with a code or link, in any browser | `jonbot/code-login` |

## What's next

1. **Meta publishing**, once Pete gets a Page admin invite from Jon. Then set Worker secrets `META_PAGE_TOKEN`, `META_PAGE_ID` and `META_IG_USER_ID`, and replace the `/publish` 501 placeholders. Do not auto-publish unconfirmed prices or reviews.
2. **Add Jon** to the allowlist and notifications (email and WhatsApp). He needs his own CallMeBot activation before WhatsApp will work for him.
3. **Sunday review mail and Thursday photo nudges** are already wired; confirm they feel right once Jon is on the list.
4. Staging / FTP (`ONAROLL_FTP_PASSWORD`) and diary routines were already on hold and stay that way until Pete says otherwise.

Pete's OK is still required before anything is submitted, published, sent or paid for. Never invent prices, reviews or job details. Never put the board key, CallMeBot key, or other secrets in chat.

## Useful paths

- Live page: https://four2d.github.io/onaroll-garage-doors/
- Worker: https://onaroll-posts.dent-pete.workers.dev
- Worker source: `worker/src/index.js` (see also `worker/README.md` and `worker/wrangler.toml`)
- Playwright: `tests/playwright/`
- Validator tests: `tests/test-validator.mjs`
- Deploy helper: `scripts/build-cf-deploy.mjs`
- Screenshots: `docs/screenshots/`
