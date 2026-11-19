# Playwright tests (390×844)

These specs serve the local `index.html` and call the live Worker at https://onaroll-posts.dent-pete.workers.dev.

They need environment variables, never hard-coded values:

- `ONAROLL_BOARD_KEY` — board key (for API setup and the “Have a board code?” fallback)
- `ONAROLL_AUTH_TEST_HOOK` — required by `code-login.spec.mjs` (matches Worker secret `AUTH_TEST_HOOK`)
- optional `PW_PORT`, `OAR_ROOT`, `OAR_RESTORE_BOARD`, `OAR_SNAPSHOT_BOARD`

On the ops box, source `/home/box/.secrets/onaroll-board.env` (mode 600) first. Do not commit that file or print the values.

`code-login.spec.mjs` uses the test hook so no real email or WhatsApp is sent. `ready-now.spec.mjs` can generate and schedule posts and historically cleared the board — only run it if that is intended, and restore drafts if needed. `mojibake.spec.mjs` generates typographic posts then restores from `OAR_RESTORE_BOARD` if you set it.

```bash
npm install playwright
npx playwright install chromium
node simple-view.spec.mjs
```
