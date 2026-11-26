#!/usr/bin/env node
/**
 * Live, end-to-end multi-account test harness.
 *
 * Connects to the built server over stdio (with real OAuth credentials) and
 * exercises every tool against every configured Gmail account, plus a few
 * cross-account checks (mailbox isolation, default resolution, unknown-account
 * errors).
 *
 * It auto-discovers accounts via `list_accounts`, so it does not care what
 * aliases you chose during `auth`.
 *
 * Mutations are cleaned up: every label created is deleted again, each
 * thread/message is unlabeled, and every draft created is deleted again via
 * delete_draft (which also exercises that tool). Skip the draft round-trip
 * with --no-draft.
 *
 * Usage:
 *   node scripts/live-test.mjs                # full battery on all accounts
 *   node scripts/live-test.mjs --no-draft     # skip the create_draft step
 *   node scripts/live-test.mjs --account work # restrict to one account
 *   node scripts/live-test.mjs --read-only    # only non-mutating tools
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(__dirname, "..", "dist", "index.js");

const args = process.argv.slice(2);
const NO_DRAFT = args.includes("--no-draft");
const READ_ONLY = args.includes("--read-only");
const ONLY_ACCOUNT = (() => {
  const i = args.indexOf("--account");
  return i >= 0 ? args[i + 1] : null;
})();

// Resolve OAuth app credentials for the spawned server. Honor whatever is
// already in the environment; otherwise fall back to the known key path.
const env = { ...process.env };
if (!env.GOOGLE_CLIENT_ID && !env.GOOGLE_OAUTH_CREDENTIALS) {
  env.GOOGLE_OAUTH_CREDENTIALS = join(homedir(), ".gmail-mcp", "oauth-keys.json");
}

// --- tiny test runner -------------------------------------------------------
let passed = 0;
const failures = [];
const notes = [];
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`    ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`    ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return cond;
}
function note(msg) {
  notes.push(msg);
  console.log(`    • ${msg}`);
}

const transport = new StdioClientTransport({ command: "node", args: [serverEntry], env });
const client = new Client({ name: "live-test", version: "0.0.0" });

async function call(name, toolArgs = {}) {
  const res = await client.callTool({ name, arguments: toolArgs });
  const text = (res.content || []).map((c) => c.text ?? "").join("\n");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON (usually an error string) */
  }
  return { isError: !!res.isError, text, json };
}

await client.connect(transport);

try {
  // === 0. Discover accounts ================================================
  console.log("\n=== list_accounts ===");
  const la = await call("list_accounts");
  if (la.isError || !la.json?.accounts) {
    console.error("list_accounts failed:", la.text);
    process.exit(1);
  }
  let accounts = la.json.accounts;
  console.log(`  Found ${accounts.length} account(s):`);
  for (const a of accounts) {
    console.log(
      `    - ${a.alias} <${a.email}>${a.default ? " [default]" : ""}  auth=${a.authStatus}`,
    );
  }
  check("at least one account configured", accounts.length >= 1);
  check(
    "exactly one default account",
    accounts.filter((a) => a.default).length === 1,
    `${accounts.filter((a) => a.default).length} marked default`,
  );
  for (const a of accounts) {
    check(`auth valid: ${a.alias}`, a.authStatus === "valid", a.authStatus);
  }
  if (accounts.length >= 2) {
    const emails = accounts.map((a) => a.email.toLowerCase());
    check("accounts map to distinct mailboxes", new Set(emails).size === emails.length);
  } else {
    note("only one account configured — cross-account isolation checks will be limited");
  }

  if (ONLY_ACCOUNT) {
    accounts = accounts.filter(
      (a) => a.alias === ONLY_ACCOUNT || a.email.toLowerCase() === ONLY_ACCOUNT.toLowerCase(),
    );
    if (!accounts.length) {
      console.error(`No account matches --account ${ONLY_ACCOUNT}`);
      process.exit(1);
    }
  }

  // Remember a thread per account for the cross-account isolation test.
  const sampleThreadByAlias = {};
  const createdDrafts = [];

  // === Per-account battery =================================================
  for (const acct of accounts) {
    const A = acct.alias;
    console.log(`\n=== account: ${A} <${acct.email}> ===`);

    // --- search_threads ----------------------------------------------------
    let st = await call("search_threads", { query: "in:inbox", pageSize: 5, account: A });
    if (!st.isError && (st.json?.threads?.length ?? 0) === 0) {
      // Empty inbox? widen to most-recent threads anywhere.
      st = await call("search_threads", { pageSize: 5, account: A });
    }
    check(`search_threads [${A}]`, !st.isError, st.text.slice(0, 120));
    const threads = st.json?.threads ?? [];
    check(`search_threads returns account=${A}`, st.json?.account === A);
    note(`search_threads returned ${threads.length} thread(s)`);

    const thread = threads.find((t) => t.threadId && t.messages?.length);
    if (!thread) {
      note(`no threads available for ${A} — skipping get_thread/label tests`);
    } else {
      sampleThreadByAlias[A] = thread.threadId;
      const messageId = thread.messages[0].id;

      // --- get_thread (both formats) --------------------------------------
      const gtFull = await call("get_thread", {
        threadId: thread.threadId,
        messageFormat: "FULL_CONTENT",
        account: A,
      });
      check(`get_thread FULL_CONTENT [${A}]`, !gtFull.isError, gtFull.text.slice(0, 120));
      check(
        `get_thread returns messages [${A}]`,
        (gtFull.json?.messages?.length ?? 0) >= 1,
      );

      const gtMin = await call("get_thread", {
        threadId: thread.threadId,
        messageFormat: "MINIMAL",
        account: A,
      });
      check(`get_thread MINIMAL [${A}]`, !gtMin.isError, gtMin.text.slice(0, 120));
      check(
        `get_thread has viewUrl + messageCount [${A}]`,
        !!gtFull.json?.viewUrl && gtFull.json?.messageCount === gtFull.json?.messages?.length,
      );

      // --- get_message (formats + body window) ----------------------------
      const gm = await call("get_message", { messageId, account: A });
      check(
        `get_message PLAIN_TEXT [${A}]`,
        !gm.isError && gm.json?.message?.id === messageId && typeof gm.json?.message?.plaintextBody === "string",
        gm.text.slice(0, 120),
      );
      check(`get_message has viewUrl [${A}]`, !!gm.json?.message?.viewUrl);
      const gmMeta = await call("get_message", { messageId, messageFormat: "METADATA_ONLY", account: A });
      check(
        `get_message METADATA_ONLY omits body/subject [${A}]`,
        !gmMeta.isError && gmMeta.json?.message?.plaintextBody === undefined && gmMeta.json?.message?.subject === undefined,
      );
      const gmRaw = await call("get_message", { messageId, messageFormat: "RAW", account: A });
      check(`get_message RAW [${A}]`, !gmRaw.isError && /\r?\n\r?\n/.test(gmRaw.json?.message?.raw ?? ""));
      if (gm.json?.message?.nextBodyOffset !== undefined) {
        const gm2 = await call("get_message", {
          messageId,
          bodyOffset: gm.json.message.nextBodyOffset,
          account: A,
        });
        check(`get_message bodyOffset continues [${A}]`, !gm2.isError && !!gm2.json?.message?.plaintextBody);
      }

      // --- search_threads views -------------------------------------------
      const ids = await call("search_threads", { query: "in:inbox", pageSize: 3, view: "THREAD_VIEW_IDS_ONLY", account: A });
      check(
        `search_threads IDS_ONLY [${A}]`,
        !ids.isError && (ids.json?.threads ?? []).every((t) => t.threadId && !t.messages),
      );
      const sum = await call("search_threads", { query: "in:inbox", pageSize: 3, view: "THREAD_VIEW_SUMMARY", account: A });
      check(
        `search_threads SUMMARY (<=1 msg/thread) [${A}]`,
        !sum.isError && (sum.json?.threads ?? []).every((t) => (t.messages?.length ?? 0) <= 1),
      );

      if (!READ_ONLY) {
        // --- label lifecycle (create -> use -> rename -> delete) ----------
        const labelName = `multi-gmail-mcp-test/run-${Date.now()}-${A}`;
        const cl = await call("create_label", { displayName: labelName, colorPreset: "LABEL_COLOR_PRESET_BLUE", account: A });
        const labelId = cl.json?.label?.id;
        check(`create_label [${A}]`, !cl.isError && !!labelId, cl.text.slice(0, 120));

        if (labelId) {
          const lt = await call("label_thread", {
            threadId: thread.threadId,
            labelIds: [labelId],
            account: A,
          });
          check(`label_thread [${A}]`, !lt.isError, lt.text.slice(0, 120));

          // Verify the label actually stuck.
          const verify = await call("get_thread", {
            threadId: thread.threadId,
            messageFormat: "FULL_CONTENT",
            account: A,
          });
          const stuck = (verify.json?.messages ?? []).some((m) =>
            (m.labelIds ?? []).includes(labelId),
          );
          check(`label visible on thread after label_thread [${A}]`, stuck);

          const ut = await call("unlabel_thread", {
            threadId: thread.threadId,
            labelIds: [labelId],
            account: A,
          });
          check(`unlabel_thread [${A}]`, !ut.isError, ut.text.slice(0, 120));

          // --- message-level label round-trip -----------------------------
          const lm = await call("label_message", {
            messageId,
            labelIds: [labelId],
            account: A,
          });
          check(
            `label_message [${A}]`,
            !lm.isError && (lm.json?.labelIds ?? []).includes(labelId),
            lm.text.slice(0, 120),
          );
          const um = await call("unlabel_message", {
            messageId,
            labelIds: [labelId],
            account: A,
          });
          check(
            `unlabel_message [${A}]`,
            !um.isError && !(um.json?.labelIds ?? []).includes(labelId),
            um.text.slice(0, 120),
          );

          // --- update_message_labels (atomic add + remove) ----------------
          const uml = await call("update_message_labels", {
            messageId,
            addLabelIds: [labelId],
            account: A,
          });
          check(
            `update_message_labels add [${A}]`,
            !uml.isError && (uml.json?.labelIds ?? []).includes(labelId),
            uml.text.slice(0, 120),
          );
          const umr = await call("update_message_labels", {
            messageId,
            removeLabelIds: [labelId],
            account: A,
          });
          check(
            `update_message_labels remove [${A}]`,
            !umr.isError && !(umr.json?.labelIds ?? []).includes(labelId),
            umr.text.slice(0, 120),
          );
          const umNone = await call("update_message_labels", { messageId, account: A });
          check(`update_message_labels requires a change [${A}]`, umNone.isError);

          // --- update_label ------------------------------------------------
          const upd = await call("update_label", {
            labelId,
            displayName: `${labelName}-renamed`,
            account: A,
          });
          check(`update_label [${A}]`, !upd.isError, upd.text.slice(0, 120));

          // --- delete_label (cleanup) -------------------------------------
          const del = await call("delete_label", { labelId, account: A });
          check(`delete_label (cleanup) [${A}]`, !del.isError, del.text.slice(0, 120));
        }

        // --- delete_label refuses system labels --------------------------
        const delSys = await call("delete_label", { labelId: "INBOX", account: A });
        check(`delete_label refuses system label [${A}]`, delSys.isError);
      }
    }

    // --- list_labels ------------------------------------------------------
    const ll = await call("list_labels", { account: A });
    check(`list_labels [${A}]`, !ll.isError && Array.isArray(ll.json?.labels), ll.text.slice(0, 120));

    // --- list_drafts ------------------------------------------------------
    const ldBefore = await call("list_drafts", { account: A });
    check(`list_drafts [${A}]`, !ldBefore.isError && Array.isArray(ldBefore.json?.drafts));
    const draftsBefore = ldBefore.json?.drafts?.length ?? 0;

    // --- create_draft (note-to-self) -------------------------------------
    if (!READ_ONLY && !NO_DRAFT) {
      const subject = `[multi-gmail-mcp test] safe to delete — ${new Date().toISOString()}`;
      const cd = await call("create_draft", {
        to: [acct.email],
        subject,
        body: "Automated test draft from scripts/live-test.mjs. Safe to delete.",
        account: A,
      });
      const draftId = cd.json?.draftId;
      check(`create_draft [${A}]`, !cd.isError && !!draftId, cd.text.slice(0, 120));
      if (draftId) {
        const ldAfter = await call("list_drafts", { account: A });
        const present = (ldAfter.json?.drafts ?? []).some((d) => d.draftId === draftId);
        check(`draft appears in list_drafts [${A}]`, present, `before=${draftsBefore}`);

        // --- get_draft + list_drafts query/view ---------------------------
        const gd = await call("get_draft", { draftId, account: A });
        check(
          `get_draft [${A}]`,
          !gd.isError && (gd.json?.message?.plaintextBody ?? "").includes("Automated test draft"),
          gd.text.slice(0, 120),
        );
        const ldq = await call("list_drafts", {
          query: "subject:\"multi-gmail-mcp test\"",
          view: "DRAFT_VIEW_FULL",
          account: A,
        });
        check(
          `list_drafts query + DRAFT_VIEW_FULL [${A}]`,
          !ldq.isError &&
            (ldq.json?.drafts ?? []).some((d) => d.draftId === draftId && typeof d.plaintextBody === "string"),
        );

        // --- delete_draft (cleanup + round-trip test) --------------------
        const dd = await call("delete_draft", { draftId, account: A });
        check(`delete_draft [${A}]`, !dd.isError, dd.text.slice(0, 120));
        if (dd.isError) {
          // Couldn't delete it — report for manual cleanup.
          createdDrafts.push({ alias: A, email: acct.email, draftId });
        } else {
          const ldGone = await call("list_drafts", { account: A });
          const stillThere = (ldGone.json?.drafts ?? []).some((d) => d.draftId === draftId);
          check(`draft gone from list_drafts after delete [${A}]`, !stillThere);
        }
      }

      // --- reply draft: auto-threading + quoting (to self, then deleted) ---
      const replyTo = sampleThreadByAlias[A] ? (await call("get_thread", {
        threadId: sampleThreadByAlias[A], messageFormat: "MINIMAL", account: A,
      })).json?.messages?.[0]?.id : undefined;
      if (replyTo) {
        const rd = await call("create_draft", {
          to: [acct.email],
          body: "Automated reply test. Safe to delete.",
          replyToMessageId: replyTo,
          account: A,
        });
        const rdId = rd.json?.draftId;
        check(`create_draft reply [${A}]`, !rd.isError && !!rdId && !!rd.json?.viewUrl, rd.text.slice(0, 120));
        if (rdId) {
          const rg = await call("get_draft", { draftId: rdId, account: A });
          const body = rg.json?.message?.plaintextBody ?? "";
          check(`reply draft quotes original [${A}]`, /wrote:\n>/.test(body), body.slice(0, 120));
          check(`reply draft inherits Re: subject [${A}]`, /^re:/i.test(rg.json?.message?.subject ?? ""));

          // trash/untrash round trip on our own test draft message only.
          const mid = rd.json?.messageId;
          if (mid) {
            const tm = await call("trash_message", { messageId: mid, account: A });
            check(`trash_message (test draft) [${A}]`, !tm.isError && (tm.json?.labelIds ?? []).includes("TRASH"), tm.text.slice(0, 120));
            const um = await call("untrash_message", { messageId: mid, account: A });
            check(`untrash_message (test draft) [${A}]`, !um.isError && !(um.json?.labelIds ?? []).includes("TRASH"), um.text.slice(0, 120));
          }
          const rdd = await call("delete_draft", { draftId: rdId, account: A });
          if (rdd.isError) createdDrafts.push({ alias: A, email: acct.email, draftId: rdId });
        }
      }
    }
  }

  // === Cross-account / resolution checks ===================================
  console.log("\n=== cross-account & resolution ===");

  // Default resolution: a call with NO account uses the default and succeeds.
  const noAcct = await call("search_threads", { pageSize: 1 });
  const defAlias = accounts.find((a) => a.default)?.alias;
  if (defAlias && (!ONLY_ACCOUNT || defAlias === ONLY_ACCOUNT)) {
    check(
      "omitting account uses the default",
      !noAcct.isError && noAcct.json?.account === defAlias,
      `account=${noAcct.json?.account}`,
    );
  } else {
    note("default not in scope — skipped default-resolution check");
  }

  // Unknown account => clear error.
  const unknown = await call("search_threads", { pageSize: 1, account: "definitely-not-an-account" });
  check("unknown account errors", unknown.isError, unknown.text.slice(0, 120));

  // Mailbox isolation: a thread from account A should NOT be found in account B.
  const aliasesWithThreads = Object.keys(sampleThreadByAlias);
  if (aliasesWithThreads.length >= 2) {
    const [a1, a2] = aliasesWithThreads;
    const foreign = await call("get_thread", {
      threadId: sampleThreadByAlias[a1],
      account: a2,
    });
    check(
      `mailbox isolation: ${a1}'s thread not visible from ${a2}`,
      foreign.isError,
      "expected a not-found error",
    );
  } else {
    note("need 2 accounts with threads to test mailbox isolation — skipped");
  }

  // === Summary =============================================================
  console.log("\n" + "=".repeat(60));
  console.log(`RESULT: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  if (createdDrafts.length) {
    console.log("\nDrafts that could NOT be auto-deleted (remove manually):");
    for (const d of createdDrafts) {
      console.log(`  - ${d.alias} <${d.email}>  draftId=${d.draftId}`);
    }
  }
  console.log("=".repeat(60));

  await client.close();
  process.exit(failures.length ? 1 : 0);
} catch (err) {
  console.error("\nHarness crashed:", err?.stack || err);
  try {
    await client.close();
  } catch {}
  process.exit(2);
}
