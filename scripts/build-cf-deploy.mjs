#!/usr/bin/env node
/**
 * Build a Cloudflare MCP `execute` function that uploads worker/src/index.js.
 *
 * UTF-8 gotcha: decode the base64 source with TextDecoder, not plain atob + Blob.
 * After this kind of deploy, re-put Worker secrets (BOARD_KEY, CALLMEBOT_APIKEY,
 * AUTH_TEST_HOOK). This script never embeds secret values.
 *
 * Usage:
 *   node scripts/build-cf-deploy.mjs > /tmp/onaroll-deploy-worker.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "worker/src/index.js"));
const b64 = src.toString("base64");

const script = `async () => {
  const accountId = "7e2fd6cc6c830ed939df10ccc0d2cb6c";
  const b64 = ${JSON.stringify(b64)};
  const script = new TextDecoder("utf-8").decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  const metadata = {
    main_module: "index.js",
    compatibility_date: "2025-11-01",
    compatibility_flags: ["nodejs_compat"],
    bindings: [
      { type: "kv_namespace", name: "KV", namespace_id: "7fa483e1737841b3b642d01293402879" },
      { type: "ai", name: "AI" },
      { type: "send_email", name: "SEND_EMAIL" },
      { type: "plain_text", name: "NOTIFY_EMAILS", text: "dent.pete@gmail.com" },
      { type: "plain_text", name: "NOTIFY_FROM", text: "onaroll-posts@foxonsoftware.com" },
      { type: "plain_text", name: "BOARD_URL", text: "https://four2d.github.io/onaroll-garage-doors/" },
      { type: "plain_text", name: "WHATSAPP_PHONE", text: "+447854046904" }
    ]
  };
  const fd = new FormData();
  fd.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  fd.append("index.js", new Blob([script], { type: "application/javascript+module" }), "index.js");
  const putJson = await cloudflare.request({
    method: "PUT",
    path: \`/accounts/\${accountId}/workers/scripts/onaroll-posts\`,
    body: fd,
  });
  return {
    putSuccess: putJson.success,
    putErrors: putJson.errors || null,
    etag: putJson.result && putJson.result.etag,
    size: script.length,
    typographyOk: script.includes("Doors — Family-run"),
  };
}
`;

process.stdout.write(script);
