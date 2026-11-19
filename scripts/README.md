# Scripts

- `build-cf-deploy.mjs` — builds a Cloudflare `execute` upload function from `worker/src/index.js`, decoding the source as UTF-8 (see the deploy gotcha in `HANDOFF.md`). It does not embed secrets. After using it, re-put `BOARD_KEY`, `CALLMEBOT_APIKEY` and `AUTH_TEST_HOOK`.
- `put-secrets.example.mjs` — checks that the env var *names* for those secrets are set, and never prints values. Prefer `npx wrangler@4 secret put …`.

The preferred deploy path is still Wrangler, from `worker/`:

```bash
npx wrangler@4 deploy
npx wrangler@4 secret put BOARD_KEY
npx wrangler@4 secret put CALLMEBOT_APIKEY
npx wrangler@4 secret put AUTH_TEST_HOOK
```
