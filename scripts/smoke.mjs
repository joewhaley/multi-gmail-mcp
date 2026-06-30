#!/usr/bin/env node
/**
 * Connects to the built server over stdio and verifies:
 *   - the server starts and completes the MCP handshake,
 *   - exactly the 14 expected tools are registered,
 *   - every tool's input schema includes an optional `account` parameter.
 *
 * Run: npm run build && node scripts/smoke.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(__dirname, "..", "dist", "index.js");

const EXPECTED = [
  "search_threads",
  "get_thread",
  "create_draft",
  "list_drafts",
  "delete_draft",
  "list_labels",
  "create_label",
  "update_label",
  "delete_label",
  "label_message",
  "unlabel_message",
  "label_thread",
  "unlabel_thread",
  "list_accounts",
];

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

const transport = new StdioClientTransport({ command: "node", args: [serverEntry] });
const client = new Client({ name: "smoke-test", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();

console.log(`Connected. Server exposed ${tools.length} tools:`);
for (const t of tools) console.log(`  • ${t.name}`);

if (tools.length !== EXPECTED.length) {
  fail(`Expected ${EXPECTED.length} tools, got ${tools.length}.`);
}
const missing = EXPECTED.filter((n) => !names.includes(n));
const extra = names.filter((n) => !EXPECTED.includes(n));
if (missing.length) fail(`Missing tools: ${missing.join(", ")}`);
if (extra.length) fail(`Unexpected tools: ${extra.join(", ")}`);

const withoutAccount = tools.filter(
  (t) => !t.inputSchema?.properties || !("account" in t.inputSchema.properties),
);
if (withoutAccount.length) {
  fail(`Tools missing the optional 'account' param: ${withoutAccount.map((t) => t.name).join(", ")}`);
}

// `account` must be optional on every tool (not in the required[] list).
const requiredAccount = tools.filter((t) => (t.inputSchema?.required ?? []).includes("account"));
if (requiredAccount.length) {
  fail(`Tools where 'account' is required (should be optional): ${requiredAccount.map((t) => t.name).join(", ")}`);
}

console.log(`\n✓ All ${EXPECTED.length} tools present.`);
console.log("✓ Every tool exposes an optional 'account' parameter.");

await client.close();
process.exit(0);
