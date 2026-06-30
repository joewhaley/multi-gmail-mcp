#!/usr/bin/env node
/**
 * Terminal-side cleanup helper: delete drafts by id from a configured account.
 * The MCP server exposes a `delete_draft` tool for one-at-a-time deletes from a
 * client; this script complements it by deleting MANY drafts in one shot from
 * the command line (e.g. clearing out test drafts), using the stored account
 * credentials directly.
 *
 * Usage:
 *   node scripts/delete-draft.mjs <account> <draftId> [<draftId> ...]
 * Requires the same OAuth env as the server, e.g.:
 *   GOOGLE_OAUTH_CREDENTIALS="$HOME/.gmail-mcp/oauth-keys.json" node scripts/delete-draft.mjs personal r-364...
 */
import { google } from "googleapis";
import { loadAccounts, resolveAccount, getAuthClient } from "../dist/accounts.js";

const [account, ...draftIds] = process.argv.slice(2);
if (!account || draftIds.length === 0) {
  console.error("Usage: node scripts/delete-draft.mjs <account> <draftId> [<draftId> ...]");
  process.exit(1);
}

const data = loadAccounts();
const { alias, config } = resolveAccount(data, account);
const auth = getAuthClient(alias, config);
const gmail = google.gmail({ version: "v1", auth });

let failed = 0;
for (const id of draftIds) {
  try {
    await gmail.users.drafts.delete({ userId: "me", id });
    console.log(`✓ deleted draft ${id} from ${alias} <${config.email}>`);
  } catch (e) {
    failed++;
    console.error(`✗ ${id}: ${e?.message ?? e}`);
  }
}
process.exit(failed ? 1 : 0);
