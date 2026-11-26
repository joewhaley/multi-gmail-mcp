#!/usr/bin/env node
/**
 * Live edge-case suite: hand-built raw MIME messages are saved as DRAFTS (never
 * sent), read back through the server's Gmail layer, checked against known
 * values, and deleted. Also exercises create/update_draft merge rules and label
 * presets/visibility/parent creation (test labels are deleted afterwards).
 *
 * Covers: windows-1252 / Latin-1 bodies, RFC 2047 subjects and names, RFC 2231
 * filenames, tricky address lists, attached .eml (message/rfc822), HTML-only
 * mail, 200KB multibyte body paging, inline images, empty bodies.
 *
 * Usage: npm run build && node scripts/edge-test.mjs [account]
 * (Gmail rejects group-syntax headers in drafts; that case is a unit test.)
 */
import { google } from "googleapis";
import { loadAccounts, resolveAccount, getAuthClient } from "../dist/accounts.js";
import * as G from "../dist/gmail.js";
import { homedir } from "node:os";
if (!process.env.GOOGLE_CLIENT_ID && !process.env.GOOGLE_OAUTH_CREDENTIALS) process.env.GOOGLE_OAUTH_CREDENTIALS = homedir() + "/.gmail-mcp/oauth-keys.json";

const data = loadAccounts();
const r = resolveAccount(data, process.argv[2]);
const auth = getAuthClient(r.alias, r.config);
const ctx = { alias: r.alias, email: r.config.email };
const gmail = google.gmail({ version: "v1", auth });
const ME = r.config.email;

let pass = 0, fail = 0; const created = [];
const check = (name, cond, detail) => { if (cond) { pass++; } else { fail++; console.log(`  ✗ ${name}${detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 300) : ""}`); } };
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const CRLF = "\r\n";
async function draftFromRaw(rawStr) {
  const res = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw: b64url(Buffer.isBuffer(rawStr) ? rawStr : Buffer.from(rawStr, "latin1")) } } });
  created.push(res.data.id); return res.data;
}
const get = (draftId, extra = {}) => G.getDraft(auth, ctx, { draftId, ...extra });

try {
  // 1. windows-1252 quoted-printable with real non-ASCII bytes
  try {
    const d = await draftFromRaw([`To: ${ME}`, "Subject: cp1252 test", "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="windows-1252"', "Content-Transfer-Encoding: quoted-printable", "",
      "caf=E9 =96 =93quoted=94 =80 price"].join(CRLF));
    const g = await get(d.id);
    check("cp1252 QP decodes to Unicode", g.message.plaintextBody?.includes("café – “quoted” € price"), g.message.plaintextBody);
  } catch (e) { fail++; console.log("  ✗ CASE THREW:", e.message); }
  // 2. ISO-8859-1 base64 + RFC 2047 Q-encoded subject
  try {
    const body = Buffer.from("Grüße aus Köln", "latin1").toString("base64");
    const d = await draftFromRaw([`To: ${ME}`, "Subject: =?ISO-8859-1?Q?Gr=FC=DFe?= und =?UTF-8?B?8J+YgA==?=", "MIME-Version: 1.0",
      'Content-Type: text/plain; charset=ISO-8859-1', "Content-Transfer-Encoding: base64", "", body].join(CRLF));
    const g = await get(d.id);
    check("latin1 base64 body", g.message.plaintextBody?.trim() === "Grüße aus Köln", g.message.plaintextBody);
    check("RFC2047 subject decoded", g.message.subject === "Grüße und 😀", g.message.subject);
  } catch (e) { fail++; console.log("  ✗ CASE THREW:", e.message); }
  // 3. tricky address lists
  try {
    const d = await draftFromRaw([
      `To: "Doe, Jane" <jane@example.com>, bob@example.com (Bob Smith), =?UTF-8?B?w4lsb2TDrWU=?= <elodie@example.com>`,
      `Cc: "Quote \\"Q\\" Person" <q@example.com>`,
      `Bcc: <angle@example.com>`,
      "Subject: addr test", "MIME-Version: 1.0", "Content-Type: text/plain", "", "x"].join(CRLF));
    const g = await get(d.id, { messageFormat: "MINIMAL" });
    const m = g.message; const dn = (e) => (m.addressDisplayNames ?? []).find((x) => x.emailAddress === e)?.displayName;
    check("To parsed (comma in quoted name)", JSON.stringify(m.toRecipients) === JSON.stringify(["jane@example.com", "bob@example.com", "elodie@example.com"]), m.toRecipients);
    check("quoted display name", dn("jane@example.com") === "Doe, Jane", m.addressDisplayNames);
    check("comment display name", dn("bob@example.com") === "Bob Smith", m.addressDisplayNames);
    check("encoded-word display name", dn("elodie@example.com") === "Élodíe", m.addressDisplayNames);
    check("escaped quotes in name", JSON.stringify(m.ccRecipients) === JSON.stringify(["q@example.com"]), m.ccRecipients);
    check("escaped quote name", dn("q@example.com") === 'Quote "Q" Person', m.addressDisplayNames);
    check("bare angle bcc", JSON.stringify(m.bccRecipients) === JSON.stringify(["angle@example.com"]), m.bccRecipients);
  } catch (e) { fail++; console.log("  ✗ CASE THREW:", e.message); }
  // 4. forwarded message as message/rfc822 attachment
  try {
    const inner = ["From: Alice <alice@example.com>", "To: bob@example.com", "Subject: Inner", "Content-Type: text/plain", "", "INNER BODY TEXT"].join(CRLF);
    const d = await draftFromRaw([`To: ${ME}`, "Subject: fwd as attachment", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="B"', "",
      "--B", "Content-Type: text/plain", "", "Outer body.", "--B", 'Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="inner.eml"', "", inner, "--B--"].join(CRLF));
    const g = await get(d.id);
    check("outer body only", g.message.plaintextBody?.trim() === "Outer body.", g.message.plaintextBody);
    check("rfc822 listed as attachment", (g.message.attachments ?? []).some((a) => a.filename === "inner.eml"), g.message.attachments);
  } catch (e) { fail++; console.log("  ✗ CASE THREW:", e.message); }
  // 5. RFC 2231 and RFC 2047 attachment filenames, and text attachment not merged into body
  try {
    const d = await draftFromRaw(Buffer.from([`To: ${ME}`, "Subject: filenames", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="B"', "",
      "--B", "Content-Type: text/plain; charset=utf-8", "", "Body here.",
      "--B", "Content-Type: application/pdf", "Content-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20final.pdf", "Content-Transfer-Encoding: base64", "", "JVBERi0=",
      "--B", 'Content-Type: text/plain; name="=?UTF-8?B?bm90ZXPinJMudHh0?="', 'Content-Disposition: attachment; filename="=?UTF-8?B?bm90ZXPinJMudHh0?="', "", "attached text must not be body",
      "--B--"].join(CRLF), "utf8"));
    const g = await get(d.id);
    const names = (g.message.attachments ?? []).map((a) => a.filename);
    check("RFC2231 filename", names.includes("résumé final.pdf"), names);
    check("RFC2047 filename", names.includes("notes✓.txt"), names);
    check("text attachment not in body", !g.message.plaintextBody?.includes("must not be body"), g.message.plaintextBody);
    check("attachmentIds present", (g.message.attachmentIds ?? []).length >= 1, g.message.attachmentIds);
  } catch (e) { fail++; console.log("  ✗ CASE THREW:", e.message); }
  // 6. HTML-only with tricky markup
  try {
    const html = `<html><head><style>.x{color:red}</style><title>T</title></head><body>
      <p>Hello&nbsp;&amp;&nbsp;welcome &#x1F600; &mdash; it&rsquo;s here.</p>
      <a href='https://ex.com/a?x=1&amp;y=2'><b>Bold</b> link</a>
      <a href="https://ex.com/same">https://ex.com/same</a>
      <a href="mailto:me@ex.com">Mail me</a>
      <A HREF="https://ex.com/UPPER">Upper</A>
      <a name="anchor">no href</a>
      <table><tr><td>c1</td><td>c2</td></tr></table>
      <ol><li>one</li><li>two</li></ol>
      <p>5 &lt; 6 &amp;&amp; 7 &gt; 3</p>
      <script>alert(1)</script><!-- hidden comment -->
    </body></html>`;
    const d = await draftFromRaw(Buffer.from([`To: ${ME}`, "Subject: html only", "MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8", "", html].join(CRLF), "utf8"));
    const g = await get(d.id);
    const t = g.message.plaintextBody ?? "";
    check("entities decoded", t.includes("Hello & welcome 😀 — it’s here."), t);
    check("single-quoted href w/ nested tag", t.includes("[Bold link](https://ex.com/a?x=1&y=2)"), t);
    check("url-text link collapsed", t.includes("https://ex.com/same") && !t.includes("](https://ex.com/same)"), t);
    check("mailto link", t.includes("[Mail me](mailto:me@ex.com)"), t);
    check("uppercase tags", t.includes("[Upper](https://ex.com/UPPER)"), t);
    check("anchor w/o href keeps text", t.includes("no href"), t);
    check("list items", /- one\n- two/.test(t), t);
    check("escaped text not treated as tags", t.includes("5 < 6 && 7 > 3"), t);
    check("no script/style/title/comment", !/alert|color:red|hidden comment|\bT\b\n/.test(t), t);
    const f = await get(d.id, { messageFormat: "FULL_CONTENT" });
    check("FULL_CONTENT has htmlBody", f.message.htmlBody?.includes("<table>"), f.message.htmlBody?.slice(0, 80));
  } catch (e) { fail++; console.log("  ✗ CASE THREW:", e.message); }
  // 7. Long multibyte body: paging reconstructs exactly
  try {
    const line = "Ünïcödé 日本語 emoji 😀 — line\n";
    const body = line.repeat(4000); // ~200KB
    const d = await draftFromRaw(Buffer.from([`To: ${ME}`, "Subject: long", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", Buffer.from(body).toString("base64").replace(/.{76}/g, "$&\r\n")].join(CRLF), "utf8"));
    let offset = 0, acc = "", pages = 0;
    while (offset !== undefined && pages < 20) {
      const g = await get(d.id, { bodyOffset: offset });
      acc += g.message.plaintextBody; offset = g.message.nextBodyOffset; pages++;
      if (pages === 1) check("first page flagged truncated", g.message.bodyTruncated === true && g.message.bodyTotalBytes === Buffer.byteLength(body), [g.message.bodyTruncated, g.message.bodyTotalBytes]);
    }
    check("paged body reassembles exactly", acc === body, [acc.length, body.length, pages]);
    check("no replacement chars", !acc.includes("�"));
    const past = await get(d.id, { bodyOffset: 10_000_000 });
    check("offset past end returns empty, no next", past.message.plaintextBody === "" && past.message.nextBodyOffset === undefined, past.message);
    const raw = await get(d.id, { messageFormat: "RAW" });
    check("RAW paged", raw.message.rawTruncated === true && raw.message.nextRawOffset > 0, [raw.message.rawTruncated, raw.message.rawTotalBytes]);
  } catch (e) { fail++; console.log("  ✗ CASE THREW:", e.message); }
  // 8. Empty body and no subject
  try {
    const d = await draftFromRaw([`To: ${ME}`, "MIME-Version: 1.0", "Content-Type: text/plain", "", ""].join(CRLF));
    const g = await get(d.id);
    check("empty body ok", g.message.plaintextBody === "" && g.message.subject === "", g.message);
  } catch (e) { fail++; console.log("  ✗ CASE THREW:", e.message); }
  // 9. Inline image with Content-ID, no filename
  try {
    const d = await draftFromRaw([`To: ${ME}`, "Subject: inline", "MIME-Version: 1.0", 'Content-Type: multipart/related; boundary="R"', "",
      "--R", "Content-Type: text/html", "", '<p>Logo: <img src="cid:logo@x"></p>',
      "--R", "Content-Type: image/png", "Content-ID: <logo@x>", "Content-Disposition: inline", "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=", "--R--"].join(CRLF));
    const g = await get(d.id);
    const a = (g.message.attachments ?? [])[0];
    check("inline image listed w/ contentId", a?.inline === true && a?.contentId === "logo@x", g.message.attachments);
    check("html body converted", g.message.plaintextBody?.includes("Logo:"), g.message.plaintextBody);
  } catch (e) { fail++; console.log("  ✗ CASE THREW:", e.message); }

  // ---- create_draft / update_draft round trips --------------------------
  try {
    const c = await G.createDraft(auth, ctx, { to: [ME], subject: "orig subj", body: "orig body",
      attachments: [{ filename: "a.txt", mimeType: "text/plain", content: Buffer.from("hello").toString("base64") }] });
    created.push(c.draftId);
    check("create_draft returns id alias", c.id === c.draftId && !!c.viewUrl, c);
    const u1 = await G.updateDraft(auth, ctx, { draftId: c.draftId, subject: "new subj" });
    const g1 = await get(c.draftId);
    check("update keeps body when omitted", g1.message.plaintextBody?.trim() === "orig body", g1.message.plaintextBody);
    check("update changes subject", g1.message.subject === "new subj", g1.message.subject);
    check("update keeps To when omitted", JSON.stringify(g1.message.toRecipients) === JSON.stringify([ME]), g1.message.toRecipients);
    check("update drops attachments + reports", JSON.stringify(u1.removedAttachments) === '["a.txt"]' && !(g1.message.attachments ?? []).length, [u1.removedAttachments, g1.message.attachments]);
    check("update keeps same draft id", u1.draftId === c.draftId, u1);
    await G.updateDraft(auth, ctx, { draftId: c.draftId, htmlBody: "<p>only <b>html</b></p>", to: ["other@example.com"], cc: [] });
    const g2 = await get(c.draftId, { messageFormat: "FULL_CONTENT" });
    check("htmlBody-only update", g2.message.htmlBody?.includes("<b>html</b>") && g2.message.plaintextBody?.includes("only html"), g2.message);
    check("to replaced, empty cc keeps (none)", JSON.stringify(g2.message.toRecipients) === '["other@example.com"]' && !g2.message.ccRecipients, g2.message);
    const raw2 = await get(c.draftId, { messageFormat: "RAW" });
    check("html-only update has no text/plain part", !/text\/plain/i.test(raw2.message.raw), raw2.message.raw.slice(0, 400));
    await G.updateDraft(auth, ctx, { draftId: c.draftId, body: "plain again" });
    const raw3 = await get(c.draftId, { messageFormat: "RAW" });
    check("body-only update clears html", !/text\/html/i.test(raw3.message.raw), raw3.message.raw.slice(0, 400));
    check("subject still kept after 3 updates", (await get(c.draftId, { messageFormat: "MINIMAL" })).message.subject === "new subj");
    // update a reply draft keeps threading
    const th = await G.searchThreads(auth, ctx, { query: "in:inbox", pageSize: 1 });
    const replyTo = th.threads[0]?.messages?.at(-1)?.id;
    if (replyTo) {
      const rd = await G.createDraft(auth, ctx, { to: [ME], body: "reply", replyToMessageId: replyTo });
      created.push(rd.draftId);
      const ur = await G.updateDraft(auth, ctx, { draftId: rd.draftId, body: "edited reply" });
      const rr = await get(rd.draftId, { messageFormat: "RAW" });
      check("update keeps threadId", ur.threadId === rd.threadId, [ur.threadId, rd.threadId]);
      check("update keeps In-Reply-To", /^In-Reply-To: <.+>/m.test(rr.message.raw), rr.message.raw.slice(0, 300));
      // edge: reply-draft with no 'to' given defaults to original sender
      const rd2 = await G.createDraft(auth, ctx, { body: "auto to", replyToMessageId: replyTo, quoteOriginal: false });
      created.push(rd2.draftId);
      const g = await get(rd2.draftId, { messageFormat: "MINIMAL" });
      check("reply w/o to has recipient", (g.message.toRecipients ?? []).length === 1, g.message.toRecipients);
      check("quoteOriginal:false omits quote", !(await get(rd2.draftId)).message.plaintextBody?.includes("wrote:"));
    }
    // signature
    const sd = await G.createDraft(auth, ctx, { to: [ME], body: "sig test", htmlBody: "<p>sig test</p>", includeSignature: true });
    created.push(sd.draftId);
    check("includeSignature does not error", !!sd.draftId);
  } catch (e) { fail++; console.log("  ✗ CASE THREW:", e.message); }

  // ---- labels ------------------------------------------------------------
  const stamp = Date.now();
  const labelsToDelete = [];
  try {
    const base = `mgm-edge-${stamp}`;
    const c = await G.createLabel(auth, ctx, { displayName: `${base}/Alpha/Sprint-1`, colorPreset: "LABEL_COLOR_PRESET_GREEN", labelListVisibility: "LABEL_SHOW_IF_UNREAD", messageListVisibility: "HIDE" });
    labelsToDelete.push(c.label.id, ...(c.createdParentLabels ?? []).map((l) => l.id));
    check("nested label created", c.label.name === `${base}/Alpha/Sprint-1`, c.label);
    check("parents auto-created", (c.createdParentLabels ?? []).map((l) => l.name).join("|") === `${base}|${base}/Alpha`, c.createdParentLabels);
    check("preset color applied", c.label.backgroundColor === "#16a765" && c.label.textColor === "#ffffff", c.label);
    check("visibility applied", c.label.labelListVisibility === "labelShowIfUnread" && c.label.messageListVisibility === "hide", c.label);
    const c2 = await G.createLabel(auth, ctx, { displayName: `${base}/Beta`, autoCreateParentLabels: false });
    labelsToDelete.push(c2.label.id);
    check("no parents when disabled (parent already exists anyway)", !c2.createdParentLabels, c2);
    const u = await G.updateLabel(auth, ctx, { labelId: c2.label.id, displayName: `${base}/Gamma`, colorPreset: "LABEL_COLOR_PRESET_BROWN" });
    check("update_label rename+preset", u.label.name === `${base}/Gamma` && u.label.backgroundColor === "#7a4706", u.label);
    let err;
    try { await G.updateLabel(auth, ctx, { labelId: c2.label.id }); } catch (e) { err = e.message; }
    check("update_label with nothing errors", /Nothing to update/.test(err ?? ""), err);
    err = undefined;
    try { await G.createLabel(auth, ctx, { displayName: `${base}/X`, colorPreset: "LABEL_COLOR_PRESET_RED", textColor: "#000000", backgroundColor: "#ffffff" }); } catch (e) { err = e.message; }
    check("preset + raw colors rejected", /either colorPreset or raw/.test(err ?? ""), err);
    err = undefined;
    try { await G.createLabel(auth, ctx, { displayName: `${base}/Alpha/Sprint-1` }); } catch (e) { err = G.describeGmailError(e, ctx.alias).message; }
    check("duplicate label gives clear error", !!err && !/undefined/.test(err), err);
    err = undefined;
    try { G.assertNoSpamRemoval(["INBOX", "spam"], "thread"); } catch (e) { err = e.message; }
    check("SPAM guard (case-insensitive)", /unmark_thread_spam/.test(err ?? ""), err);
  } finally {
    for (const id of labelsToDelete.reverse()) { try { await gmail.users.labels.delete({ userId: "me", id }); } catch (e) { console.log("  ! cleanup label", id, e.message); } }
  }
} finally {
  for (const id of created) { try { await gmail.users.drafts.delete({ userId: "me", id }); } catch (e) { console.log("  ! cleanup draft", id, e.message); } }
  console.log(`\n${pass} passed, ${fail} failed (cleaned up ${created.length} drafts)`);
  process.exitCode = fail ? 1 : 0;
}
