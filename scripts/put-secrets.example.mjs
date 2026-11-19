#!/usr/bin/env node
/**
 * Example only — do not commit a filled copy.
 *
 * Reads secret *values* from the environment (or a local env file you pass in)
 * and documents the Worker secret *names* to put:
 *
 *   BOARD_KEY          <- ONAROLL_BOARD_KEY
 *   CALLMEBOT_APIKEY   <- ONAROLL_CALLMEBOT_APIKEY
 *   AUTH_TEST_HOOK     <- ONAROLL_AUTH_TEST_HOOK
 *
 * Preferred:
 *   npx wrangler@4 secret put BOARD_KEY
 *   npx wrangler@4 secret put CALLMEBOT_APIKEY
 *   npx wrangler@4 secret put AUTH_TEST_HOOK
 *
 * This file never prints secret values.
 */
const names = [
  ["BOARD_KEY", "ONAROLL_BOARD_KEY"],
  ["CALLMEBOT_APIKEY", "ONAROLL_CALLMEBOT_APIKEY"],
  ["AUTH_TEST_HOOK", "ONAROLL_AUTH_TEST_HOOK"],
];

const missing = names.filter(([, envName]) => !process.env[envName]).map(([, envName]) => envName);
console.log("Worker secret names to put:", names.map(([n]) => n).join(", "));
if (missing.length) {
  console.log("Missing env vars (values not printed):", missing.join(", "));
  process.exit(1);
}
console.log("All expected env vars are set. Use wrangler secret put; do not echo the values.");
