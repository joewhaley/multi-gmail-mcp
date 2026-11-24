/**
 * Thin, well-typed wrappers over the Gmail REST API (gmail.users.*), shared by
 * every tool. Responsibilities:
 *   - build/normalize search queries (draft + trash handling)
 *   - decode MIME parts into plain text / HTML + attachment metadata, paginating
 *     long bodies in UTF-8-safe ~50KB windows
 *   - retry transient failures (rate limits / 5xx) with exponential backoff
 *   - translate Gmail/OAuth errors into actionable, human-readable messages
 *
 * All calls operate on userId "me" against the OAuth2 client passed in.
 */
import { google, type gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import {
  buildMimeMessage,
  assertAttachmentSize,
  type MimeAttachment,
} from "./mime.js";
import { htmlToText, sliceUtf8, quotePlain, quoteHtml, plainToHtml } from "./content.js";

/** ~50KB window of body text returned per call (continue with bodyOffset). */
const MAX_BODY_BYTES = 50 * 1024;
/** Bound concurrency when fanning out per-thread / per-draft metadata fetches. */
const FANOUT_CONCURRENCY = 8;

function gmailClient(auth: OAuth2Client): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth });
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/** Carries a pre-formatted, user-safe message for a failed Gmail operation. */
export class GmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailError";
  }
}

function httpStatus(err: any): number | undefined {
  return err?.code ?? err?.status ?? err?.response?.status;
}

function errorReasons(err: any): string[] {
  const fromResponse = err?.response?.data?.error?.errors ?? [];
  const reasons = fromResponse.map((e: any) => e?.reason).filter(Boolean) as string[];
  if (err?.errors) {
    for (const e of err.errors) if (e?.reason) reasons.push(e.reason);
  }
  return reasons;
}

function isInvalidGrant(err: any): boolean {
  const data = err?.response?.data;
  if (data?.error === "invalid_grant") return true;
  const msg = String(err?.message ?? "");
  return msg.includes("invalid_grant");
}

function isRateLimit(err: any): boolean {
  const status = httpStatus(err);
  if (status === 429) return true;
  if (status === 403) {
    const reasons = errorReasons(err);
    return reasons.some((r) => r === "rateLimitExceeded" || r === "userRateLimitExceeded");
  }
  return false;
}

function isRetryable(err: any): boolean {
  const status = httpStatus(err);
  if (isRateLimit(err)) return true;
  return typeof status === "number" && status >= 500 && status < 600;
}

/**
 * Translate any thrown error into a GmailError with a clear, actionable message.
 * `alias` is woven into auth errors so the user knows which account to re-auth.
 */
export function describeGmailError(err: any, alias: string): GmailError {
  if (err instanceof GmailError) return err;

  const status = httpStatus(err);

  if (isInvalidGrant(err) || status === 401) {
    return new GmailError(
      `Authentication for account "${alias}" has expired or been revoked. ` +
        `Re-authorize with: npx multi-gmail-mcp auth ${alias}`,
    );
  }
  if (isRateLimit(err)) {
    return new GmailError(
      `Gmail rate limit hit for account "${alias}" and retries were exhausted. Try again shortly.`,
    );
  }
  if (status === 404) {
    return new GmailError("The requested thread, message, draft, or label was not found (404).");
  }
  if (status === 403) {
    return new GmailError(
      `Permission denied by Gmail for account "${alias}" (403). ` +
        `Ensure the Gmail API is enabled and the gmail.modify/gmail.labels scopes were granted.`,
    );
  }

  // Fall back to the API's own message, never a raw stack trace.
  const apiMessage =
    err?.response?.data?.error?.message ?? err?.message ?? "Unknown Gmail API error.";
  const prefix = status ? `Gmail API error (${status}): ` : "Gmail API error: ";
  return new GmailError(prefix + apiMessage);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn`, retrying transient failures up to `attempts` times with backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts - 1 && isRetryable(err)) {
        // Exponential backoff with jitter: ~0.5s, 1s, 2s.
        const delay = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** Run async tasks with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Search query construction
// ---------------------------------------------------------------------------

/**
 * Normalize a Gmail search query to match the standard connector's semantics:
 *   - Drafts are excluded by default (append `-in:draft`) unless the caller
 *     explicitly references drafts (`in:draft` / `-in:draft`).
 *   - Trash & spam are excluded by default; `includeTrash` widens the search to
 *     everywhere (append `in:anywhere`) unless the query already scopes folders.
 *
 * Exported for unit testing query passthrough.
 */
export function buildSearchQuery(query?: string, includeTrash = false): string {
  const parts: string[] = [];
  const base = (query ?? "").trim();
  if (base) parts.push(base);

  const lower = base.toLowerCase();

  if (!/\bin:draft\b/.test(lower) && !/\bin:anywhere\b/.test(lower)) {
    parts.push("-in:draft");
  }

  if (includeTrash) {
    if (!/\bin:(anywhere|trash|spam)\b/.test(lower)) parts.push("in:anywhere");
  }

  return parts.join(" ").trim();
}

// ---------------------------------------------------------------------------
// Account context + view URLs
// ---------------------------------------------------------------------------

/** The resolved account a call runs against. */
export interface AccountCtx {
  alias: string;
  email: string;
}

/** Gmail web URL for a message or thread ID in a specific account. */
export function viewUrl(email: string, id: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#all/${id}`;
}

/** Gmail web URL that opens a draft (by its message ID) in the composer. */
export function draftViewUrl(email: string, messageId: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#drafts?compose=${messageId}`;
}

// ---------------------------------------------------------------------------
// Header / body decoding
// ---------------------------------------------------------------------------

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export interface AttachmentMeta {
  /** Pass to Gmail's attachments.get; absent for small parts whose data came inline. */
  attachmentId?: string;
  partId?: string;
  filename: string;
  mimeType: string;
  size: number;
  inline?: boolean;
  contentId?: string;
}

interface ExtractedContent {
  plain: string;
  html: string;
  attachments: AttachmentMeta[];
}

/** Is this MIME part a file (as opposed to body text)? */
function isAttachmentPart(part: gmail_v1.Schema$MessagePart): boolean {
  const mimeType = (part.mimeType ?? "").toLowerCase();
  if (mimeType.startsWith("multipart/")) return false;
  if (part.filename) return true;
  const disposition = header(part.headers ?? undefined, "Content-Disposition").toLowerCase();
  if (disposition.startsWith("attachment")) return true;
  // Non-text parts stored out-of-line (e.g. unnamed inline images).
  if (part.body?.attachmentId && !mimeType.startsWith("text/")) return true;
  return false;
}

/**
 * Walk a message payload collecting body text (text/plain and text/html) and
 * attachment metadata. Text parts that Gmail stores out-of-line (large bodies
 * referenced by attachmentId) are fetched so the body is never silently empty.
 */
/** Exported for unit testing. */
export async function extractContent(
  gmail: gmail_v1.Gmail,
  messageId: string,
  payload: gmail_v1.Schema$MessagePart | undefined,
): Promise<ExtractedContent> {
  const attachments: AttachmentMeta[] = [];
  const textParts: { kind: "plain" | "html"; data?: string; attachmentId?: string }[] = [];

  const walk = (part: gmail_v1.Schema$MessagePart | undefined) => {
    if (!part) return;
    const mimeType = (part.mimeType ?? "").toLowerCase();
    const body = part.body;

    if (isAttachmentPart(part)) {
      const meta: AttachmentMeta = {
        filename: part.filename || "(unnamed)",
        mimeType: part.mimeType || "application/octet-stream",
        size: body?.size ?? 0,
      };
      if (body?.attachmentId) meta.attachmentId = body.attachmentId;
      if (part.partId) meta.partId = part.partId;
      const disposition = header(part.headers ?? undefined, "Content-Disposition").toLowerCase();
      if (disposition.startsWith("inline")) meta.inline = true;
      const cid = header(part.headers ?? undefined, "Content-ID").replace(/^<|>$/g, "");
      if (cid) meta.contentId = cid;
      attachments.push(meta);
    } else if (mimeType === "text/plain" || mimeType === "text/html") {
      const kind = mimeType === "text/plain" ? "plain" : "html";
      if (body?.data) textParts.push({ kind, data: body.data });
      else if (body?.attachmentId) textParts.push({ kind, attachmentId: body.attachmentId });
    }

    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);

  const decoded = await Promise.all(
    textParts.map(async (p) => {
      let data = p.data;
      if (!data && p.attachmentId) {
        const res = await withRetry(() =>
          gmail.users.messages.attachments.get({ userId: "me", messageId, id: p.attachmentId! }),
        );
        data = res.data.data ?? "";
      }
      return { kind: p.kind, text: decodeBase64Url(data ?? "").toString("utf8") };
    }),
  );

  const plain = decoded.filter((d) => d.kind === "plain").map((d) => d.text).join("\n");
  const html = decoded.filter((d) => d.kind === "html").map((d) => d.text).join("\n");
  return { plain, html, attachments };
}

/** Best plain-text rendering: the text/plain part, else HTML converted to text. */
function bestPlainText(content: ExtractedContent): string {
  return content.plain.trim() ? content.plain : htmlToText(content.html);
}

// ---------------------------------------------------------------------------
// Message formats + shaping
// ---------------------------------------------------------------------------

/**
 * Output formats, matching the standard connector:
 *   METADATA_ONLY  ids, labels, addresses, date, size, viewUrl
 *   MINIMAL        + subject, snippet
 *   PLAIN_TEXT     + plain-text body (HTML converted when no text part) + attachments  (default)
 *   FULL_CONTENT   + htmlBody
 *   RAW            the raw RFC 2822 message (get_message / get_draft only)
 */
export type MessageFormat = "METADATA_ONLY" | "MINIMAL" | "PLAIN_TEXT" | "FULL_CONTENT" | "RAW";

export function normalizeFormat(format?: string): MessageFormat {
  switch (format) {
    case "METADATA_ONLY":
    case "MINIMAL":
    case "FULL_CONTENT":
    case "RAW":
      return format;
    default:
      return "PLAIN_TEXT";
  }
}

const META_HEADERS = ["Subject", "From", "To", "Cc", "Bcc", "Date", "Reply-To", "Message-ID"];

function apiFormat(format: MessageFormat): "metadata" | "full" | "raw" {
  if (format === "RAW") return "raw";
  if (format === "METADATA_ONLY" || format === "MINIMAL") return "metadata";
  return "full";
}

export interface MessageOut {
  id: string;
  threadId?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  date?: string;
  internalDate?: string;
  labelIds?: string[];
  sizeEstimate?: number;
  viewUrl: string;
  /** RFC 822 Message-ID header (useful for threading / rfc822msgid: search). */
  rfc822MessageId?: string;
  subject?: string;
  snippet?: string;
  body?: string;
  bodyTotalBytes?: number;
  bodyTruncated?: boolean;
  nextBodyOffset?: number;
  htmlBody?: string;
  htmlBodyTotalBytes?: number;
  htmlBodyTruncated?: boolean;
  nextHtmlBodyOffset?: number;
  attachments?: AttachmentMeta[];
  raw?: string;
  rawTotalBytes?: number;
  rawTruncated?: boolean;
  nextRawOffset?: number;
}

export interface BodyWindow {
  bodyOffset?: number;
  htmlBodyOffset?: number;
}

function setIf<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | "" | undefined) {
  if (value !== undefined && value !== "") obj[key] = value as T[K];
}

/** Shape a Gmail API message into the requested output format. */
async function shapeMessage(
  gmail: gmail_v1.Gmail,
  ctx: AccountCtx,
  msg: gmail_v1.Schema$Message,
  format: MessageFormat,
  window: BodyWindow = {},
): Promise<MessageOut> {
  const id = msg.id ?? "";
  const out: MessageOut = { id, viewUrl: viewUrl(ctx.email, id) };
  setIf(out, "threadId", msg.threadId ?? undefined);
  if (msg.labelIds) out.labelIds = msg.labelIds;
  if (msg.sizeEstimate != null) out.sizeEstimate = msg.sizeEstimate;
  setIf(out, "internalDate", msg.internalDate ?? undefined);

  if (format === "RAW") {
    setIf(out, "snippet", msg.snippet ?? undefined);
    const rawText = decodeBase64Url(msg.raw ?? "").toString("utf8");
    const slice = sliceUtf8(rawText, window.bodyOffset ?? 0, MAX_BODY_BYTES);
    out.raw = slice.text;
    out.rawTotalBytes = slice.totalBytes;
    if (slice.nextOffset !== undefined) {
      out.rawTruncated = true;
      out.nextRawOffset = slice.nextOffset;
    }
    return out;
  }

  const h = msg.payload?.headers ?? undefined;
  setIf(out, "from", header(h, "From"));
  setIf(out, "to", header(h, "To"));
  setIf(out, "cc", header(h, "Cc"));
  setIf(out, "bcc", header(h, "Bcc"));
  setIf(out, "replyTo", header(h, "Reply-To"));
  setIf(out, "date", header(h, "Date"));
  setIf(out, "rfc822MessageId", header(h, "Message-ID"));
  if (format === "METADATA_ONLY") return out;

  out.subject = header(h, "Subject");
  out.snippet = msg.snippet ?? "";
  if (format === "MINIMAL") return out;

  const content = await extractContent(gmail, id, msg.payload);
  const body = sliceUtf8(bestPlainText(content), window.bodyOffset ?? 0, MAX_BODY_BYTES);
  out.body = body.text;
  out.bodyTotalBytes = body.totalBytes;
  if (body.nextOffset !== undefined) {
    out.bodyTruncated = true;
    out.nextBodyOffset = body.nextOffset;
  }
  if (content.attachments.length > 0) out.attachments = content.attachments;

  if (format === "FULL_CONTENT" && content.html) {
    const html = sliceUtf8(content.html, window.htmlBodyOffset ?? 0, MAX_BODY_BYTES);
    out.htmlBody = html.text;
    out.htmlBodyTotalBytes = html.totalBytes;
    if (html.nextOffset !== undefined) {
      out.htmlBodyTruncated = true;
      out.nextHtmlBodyOffset = html.nextOffset;
    }
  }
  return out;
}

const TRUNCATION_NOTE =
  "Bodies are returned in windows of ~50KB. When bodyTruncated is true, call get_message with " +
  "bodyOffset=nextBodyOffset (or htmlBodyOffset=nextHtmlBodyOffset) to read the rest.";

// ---------------------------------------------------------------------------
// search_threads
// ---------------------------------------------------------------------------

export type ThreadView = "MINIMAL" | "METADATA_ONLY" | "IDS_ONLY" | "SUMMARY";

export function normalizeThreadView(view?: string): ThreadView {
  switch (view) {
    case "THREAD_VIEW_METADATA_ONLY":
    case "METADATA_ONLY":
      return "METADATA_ONLY";
    case "THREAD_VIEW_IDS_ONLY":
    case "IDS_ONLY":
      return "IDS_ONLY";
    case "THREAD_VIEW_SUMMARY":
    case "SUMMARY":
      return "SUMMARY";
    default:
      return "MINIMAL";
  }
}

/** Max messages returned per thread by search_threads (matches the connector). */
const SEARCH_MESSAGES_PER_THREAD = 5;

export interface ThreadSummary {
  threadId: string;
  viewUrl: string;
  messageCount?: number;
  messages?: MessageOut[];
}

export interface SearchThreadsResult {
  account: string;
  threads: ThreadSummary[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
  note: string;
}

function isDraft(msg: gmail_v1.Schema$Message): boolean {
  return (msg.labelIds ?? []).includes("DRAFT");
}

export async function searchThreads(
  auth: OAuth2Client,
  ctx: AccountCtx,
  params: {
    query?: string;
    pageSize?: number;
    pageToken?: string;
    includeTrash?: boolean;
    view?: string;
  },
): Promise<SearchThreadsResult> {
  const gmail = gmailClient(auth);
  const q = buildSearchQuery(params.query, params.includeTrash);
  const maxResults = Math.min(Math.max(params.pageSize ?? 20, 1), 50);
  const view = normalizeThreadView(params.view);

  const list = await withRetry(() =>
    gmail.users.threads.list({
      userId: "me",
      q: q || undefined,
      maxResults,
      pageToken: params.pageToken || undefined,
      includeSpamTrash: params.includeTrash ? true : undefined,
    }),
  );

  const stubs = list.data.threads ?? [];
  let threads: ThreadSummary[];
  if (view === "IDS_ONLY") {
    threads = stubs.map((s) => ({ threadId: s.id ?? "", viewUrl: viewUrl(ctx.email, s.id ?? "") }));
  } else {
    const msgFormat: MessageFormat = view === "METADATA_ONLY" ? "METADATA_ONLY" : "MINIMAL";
    threads = await mapLimit(stubs, FANOUT_CONCURRENCY, async (stub) => {
      const detail = await withRetry(() =>
        gmail.users.threads.get({
          userId: "me",
          id: stub.id!,
          format: "metadata",
          metadataHeaders: META_HEADERS,
        }),
      );
      const all = (detail.data.messages ?? []).filter((m) => !isDraft(m));
      const keep = view === "SUMMARY" ? 1 : SEARCH_MESSAGES_PER_THREAD;
      const subset = all.slice(-keep);
      const messages = await Promise.all(
        subset.map((m) => shapeMessage(gmail, ctx, m, msgFormat)),
      );
      const threadId = detail.data.id ?? stub.id ?? "";
      return {
        threadId,
        viewUrl: viewUrl(ctx.email, threadId),
        messageCount: all.length,
        messages,
      } satisfies ThreadSummary;
    });
  }

  const result: SearchThreadsResult = {
    account: ctx.alias,
    threads,
    note:
      view === "IDS_ONLY"
        ? "Only thread IDs were fetched. Use get_thread to read a thread."
        : `Message bodies are not included; at most the ${view === "SUMMARY" ? "latest message" : `${SEARCH_MESSAGES_PER_THREAD} most recent messages`} per thread are shown (see messageCount). Use get_thread to read every message.`,
  };
  if (list.data.nextPageToken) result.nextPageToken = list.data.nextPageToken;
  if (list.data.resultSizeEstimate != null) result.resultSizeEstimate = list.data.resultSizeEstimate;
  return result;
}

// ---------------------------------------------------------------------------
// get_thread / get_message
// ---------------------------------------------------------------------------

export async function getThread(
  auth: OAuth2Client,
  ctx: AccountCtx,
  params: { threadId: string; messageFormat?: string },
): Promise<{
  account: string;
  threadId: string;
  viewUrl: string;
  messageCount: number;
  messages: MessageOut[];
  note?: string;
}> {
  const gmail = gmailClient(auth);
  let format = normalizeFormat(params.messageFormat);
  if (format === "RAW") format = "FULL_CONTENT"; // RAW is per-message only.
  const fmt = apiFormat(format);

  const res = await withRetry(() =>
    gmail.users.threads.get({
      userId: "me",
      id: params.threadId,
      format: fmt as "metadata" | "full",
      ...(fmt === "metadata" ? { metadataHeaders: META_HEADERS } : {}),
    }),
  );

  // Drafts are omitted (use list_drafts / get_draft), matching the connector.
  const raw = (res.data.messages ?? []).filter((m) => !isDraft(m));
  const messages = await mapLimit(raw, FANOUT_CONCURRENCY, (m) => shapeMessage(gmail, ctx, m, format));
  const threadId = res.data.id ?? params.threadId;
  const out: {
    account: string;
    threadId: string;
    viewUrl: string;
    messageCount: number;
    messages: MessageOut[];
    note?: string;
  } = { account: ctx.alias, threadId, viewUrl: viewUrl(ctx.email, threadId), messageCount: messages.length, messages };
  if (messages.some((m) => m.bodyTruncated || m.htmlBodyTruncated)) out.note = TRUNCATION_NOTE;
  return out;
}

export async function getMessage(
  auth: OAuth2Client,
  ctx: AccountCtx,
  params: { messageId: string; messageFormat?: string } & BodyWindow,
): Promise<{ account: string; message: MessageOut; note?: string }> {
  const gmail = gmailClient(auth);
  const format = normalizeFormat(params.messageFormat);
  const fmt = apiFormat(format);
  const res = await withRetry(() =>
    gmail.users.messages.get({
      userId: "me",
      id: params.messageId,
      format: fmt,
      ...(fmt === "metadata" ? { metadataHeaders: META_HEADERS } : {}),
    }),
  );
  const message = await shapeMessage(gmail, ctx, res.data, format, params);
  const out: { account: string; message: MessageOut; note?: string } = { account: ctx.alias, message };
  if (message.bodyTruncated || message.htmlBodyTruncated) out.note = TRUNCATION_NOTE;
  if (message.rawTruncated) {
    out.note = "Raw message truncated; call again with bodyOffset=nextRawOffset to continue.";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export interface CreateDraftParams {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  replyToMessageId?: string;
  /** Append the quoted original below a reply. Defaults to true. */
  quoteOriginal?: boolean;
  includeSignature?: boolean;
  attachments?: MimeAttachment[];
}

/** Fetch the HTML signature of the account's default send-as identity. */
async function defaultSignature(gmail: gmail_v1.Gmail): Promise<string> {
  const res = await withRetry(() => gmail.users.settings.sendAs.list({ userId: "me" }));
  const identities = res.data.sendAs ?? [];
  const chosen =
    identities.find((s) => s.isDefault) ?? identities.find((s) => s.isPrimary) ?? identities[0];
  return chosen?.signature ?? "";
}

export async function createDraft(
  auth: OAuth2Client,
  ctx: AccountCtx,
  params: CreateDraftParams,
): Promise<{
  account: string;
  draftId: string;
  messageId?: string;
  threadId?: string;
  to?: string[];
  viewUrl?: string;
}> {
  const gmail = gmailClient(auth);
  assertAttachmentSize(params.attachments);

  let to = (params.to ?? []).filter((a) => a.trim());
  let body = params.body;
  let htmlBody = params.htmlBody;
  let inReplyTo: string | undefined;
  let references: string | undefined;
  let threadId: string | undefined;
  let subject = params.subject;

  // Signature goes directly under the new text, above any quoted reply.
  if (params.includeSignature) {
    const sig = await defaultSignature(gmail);
    if (sig) {
      if (htmlBody !== undefined) htmlBody += `<br><br><div class="gmail_signature">${sig}</div>`;
      if (body !== undefined || htmlBody === undefined) {
        body = `${body ?? ""}\n\n-- \n${htmlToText(sig)}`;
      }
    }
  }

  if (params.replyToMessageId) {
    const quote = params.quoteOriginal ?? true;
    const original = await withRetry(() =>
      gmail.users.messages.get({
        userId: "me",
        id: params.replyToMessageId!,
        format: quote ? "full" : "metadata",
        ...(quote ? {} : { metadataHeaders: [...META_HEADERS, "References"] }),
      }),
    );
    const h = original.data.payload?.headers ?? undefined;
    const messageIdHeader = header(h, "Message-ID");
    const existingRefs = header(h, "References");
    const origSubject = header(h, "Subject");
    const origFrom = header(h, "From");

    threadId = original.data.threadId ?? undefined;
    if (messageIdHeader) {
      inReplyTo = messageIdHeader;
      references = [existingRefs, messageIdHeader].filter(Boolean).join(" ").trim();
    }
    if (!subject && origSubject) {
      subject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
    }
    // Default recipient: whoever we'd reply to. If the original was our own
    // sent message, reply to its recipients instead.
    if (to.length === 0) {
      const sentByMe = (original.data.labelIds ?? []).includes("SENT");
      const target = sentByMe ? header(h, "To") : header(h, "Reply-To") || origFrom;
      if (target) to = [target];
    }

    if (quote) {
      const content = await extractContent(gmail, original.data.id ?? "", original.data.payload);
      const attribution = `On ${header(h, "Date")}, ${origFrom} wrote:`;
      const origPlain = bestPlainText(content);
      if (htmlBody !== undefined) {
        htmlBody += "<br>" + quoteHtml(attribution, content.html || plainToHtml(origPlain));
      }
      if (body !== undefined || htmlBody === undefined) {
        body = `${body ?? ""}\n\n${quotePlain(attribution, origPlain)}`;
      }
    }
  }

  const raw = buildMimeMessage({
    to,
    cc: params.cc,
    bcc: params.bcc,
    subject,
    body,
    htmlBody,
    attachments: params.attachments,
    inReplyTo,
    references,
  });

  const res = await withRetry(() =>
    gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw, ...(threadId ? { threadId } : {}) } },
    }),
  );

  const out: {
    account: string;
    draftId: string;
    messageId?: string;
    threadId?: string;
    to?: string[];
    viewUrl?: string;
  } = { account: ctx.alias, draftId: res.data.id ?? "" };
  if (res.data.message?.id) {
    out.messageId = res.data.message.id;
    out.viewUrl = draftViewUrl(ctx.email, res.data.message.id);
  }
  if (res.data.message?.threadId) out.threadId = res.data.message.threadId;
  if (to.length) out.to = to;
  return out;
}

export interface DraftSummary {
  draftId: string;
  messageId: string;
  threadId?: string;
  subject: string;
  to?: string;
  cc?: string;
  bcc?: string;
  date?: string;
  snippet: string;
  viewUrl: string;
  body?: string;
  bodyTruncated?: boolean;
}

export async function listDrafts(
  auth: OAuth2Client,
  ctx: AccountCtx,
  params: { pageSize?: number; pageToken?: string; query?: string; view?: string },
): Promise<{ account: string; drafts: DraftSummary[]; nextPageToken?: string }> {
  const gmail = gmailClient(auth);
  const maxResults = Math.min(Math.max(params.pageSize ?? 20, 1), 50);
  const full = params.view === "DRAFT_VIEW_FULL" || params.view === "FULL";

  const list = await withRetry(() =>
    gmail.users.drafts.list({
      userId: "me",
      maxResults,
      pageToken: params.pageToken || undefined,
      q: params.query?.trim() || undefined,
    }),
  );

  const stubs = list.data.drafts ?? [];
  const drafts = await mapLimit(stubs, FANOUT_CONCURRENCY, async (stub) => {
    const msgId = stub.message!.id!;
    const msg = await withRetry(() =>
      gmail.users.messages.get({
        userId: "me",
        id: msgId,
        format: full ? "full" : "metadata",
        ...(full ? {} : { metadataHeaders: META_HEADERS }),
      }),
    );
    const h = msg.data.payload?.headers ?? undefined;
    const d: DraftSummary = {
      draftId: stub.id ?? "",
      messageId: msgId,
      subject: header(h, "Subject"),
      snippet: msg.data.snippet ?? "",
      viewUrl: draftViewUrl(ctx.email, msgId),
    };
    setIf(d, "threadId", msg.data.threadId ?? undefined);
    setIf(d, "to", header(h, "To"));
    setIf(d, "cc", header(h, "Cc"));
    setIf(d, "bcc", header(h, "Bcc"));
    setIf(d, "date", header(h, "Date"));
    if (full) {
      const content = await extractContent(gmail, msgId, msg.data.payload);
      const slice = sliceUtf8(bestPlainText(content), 0, MAX_BODY_BYTES);
      d.body = slice.text;
      if (slice.nextOffset !== undefined) d.bodyTruncated = true;
    }
    return d;
  });

  const out: { account: string; drafts: DraftSummary[]; nextPageToken?: string } = {
    account: ctx.alias,
    drafts,
  };
  if (list.data.nextPageToken) out.nextPageToken = list.data.nextPageToken;
  return out;
}

export async function getDraft(
  auth: OAuth2Client,
  ctx: AccountCtx,
  params: { draftId: string; messageFormat?: string } & BodyWindow,
): Promise<{ account: string; draftId: string; message: MessageOut; note?: string }> {
  const gmail = gmailClient(auth);
  const format = normalizeFormat(params.messageFormat);
  const res = await withRetry(() =>
    gmail.users.drafts.get({ userId: "me", id: params.draftId, format: apiFormat(format) }),
  );
  const msg = res.data.message ?? {};
  const message = await shapeMessage(gmail, ctx, msg, format, params);
  if (msg.id) message.viewUrl = draftViewUrl(ctx.email, msg.id);
  const out: { account: string; draftId: string; message: MessageOut; note?: string } = {
    account: ctx.alias,
    draftId: res.data.id ?? params.draftId,
    message,
  };
  if (message.bodyTruncated || message.htmlBodyTruncated || message.rawTruncated) {
    out.note = "Content truncated; call get_draft again with bodyOffset/htmlBodyOffset set to the next* offset.";
  }
  return out;
}

export async function deleteDraft(
  auth: OAuth2Client,
  ctx: AccountCtx,
  params: { draftId: string },
): Promise<{ account: string; deletedDraftId: string }> {
  const gmail = gmailClient(auth);
  // drafts.delete permanently removes the draft (it is NOT moved to Trash).
  // A missing draft surfaces as a 404, which describeGmailError maps cleanly.
  await withRetry(() => gmail.users.drafts.delete({ userId: "me", id: params.draftId }));
  return { account: ctx.alias, deletedDraftId: params.draftId };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export interface LabelInfo {
  id: string;
  name: string;
  type: string;
  textColor?: string;
  backgroundColor?: string;
}

function toLabelInfo(label: gmail_v1.Schema$Label): LabelInfo {
  const info: LabelInfo = {
    id: label.id ?? "",
    name: label.name ?? "",
    type: label.type ?? "user",
  };
  if (label.color?.textColor) info.textColor = label.color.textColor;
  if (label.color?.backgroundColor) info.backgroundColor = label.color.backgroundColor;
  return info;
}

export async function listLabels(
  auth: OAuth2Client,
  ctx: AccountCtx,
  params: { pageSize?: number; pageToken?: string; includeSystem?: boolean },
): Promise<{ account: string; labels: LabelInfo[]; nextPageToken?: string; note: string }> {
  const gmail = gmailClient(auth);
  // Gmail's labels.list is not paginated server-side; it returns everything in
  // one call. We expose pageSize/pageToken and paginate client-side using a
  // numeric offset token.
  const res = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
  const includeSystem = params.includeSystem ?? true;
  const labels = (res.data.labels ?? [])
    .filter((l) => includeSystem || (l.type ?? "user") === "user")
    .map(toLabelInfo)
    // System labels first, then user labels alphabetically.
    .sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "system" ? -1 : 1,
    );

  const offset = Number.parseInt(params.pageToken ?? "0", 10) || 0;
  const pageSize = params.pageSize && params.pageSize > 0 ? params.pageSize : labels.length;
  const page = labels.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;

  const out: {
    account: string;
    labels: LabelInfo[];
    nextPageToken?: string;
    note: string;
  } = {
    account: ctx.alias,
    labels: page,
    note:
      "Use a label's `id` with label/unlabel tools and its `name` with the search operator label:<name>. " +
      "DRAFT and SENT are read-only. Inbox tabs are CATEGORY_PERSONAL (Primary), CATEGORY_SOCIAL, " +
      "CATEGORY_PROMOTIONS, CATEGORY_UPDATES, CATEGORY_FORUMS; a message has at most one category.",
  };
  if (nextOffset < labels.length) out.nextPageToken = String(nextOffset);
  return out;
}

/** Gmail's allowed label color palette (applies to both text and background). */
export const ALLOWED_LABEL_COLORS = new Set([
  "#000000", "#434343", "#666666", "#999999", "#cccccc", "#efefef", "#f3f3f3", "#ffffff",
  "#fb4c2f", "#ffad47", "#fad165", "#16a766", "#43d692", "#4a86e8", "#a479e2", "#f691b3",
  "#f6c5be", "#ffe6c7", "#fef1d1", "#b9e4d0", "#c6f3de", "#c9daf8", "#e4d7f5", "#fcdee8",
  "#efa093", "#ffd6a2", "#fce8b3", "#89d3b2", "#a0eac9", "#a4c2f4", "#d0bcf1", "#fbc8d9",
  "#e66550", "#ffbc6b", "#fcda83", "#44b984", "#68dfa9", "#6d9eeb", "#b694e8", "#f7a7c0",
  "#cc3a21", "#eaa041", "#f2c960", "#149e60", "#3dc789", "#3c78d8", "#8e63ce", "#e07798",
  "#ac2b16", "#cf8933", "#d5ae49", "#0b804b", "#2a9c68", "#285bac", "#653e9b", "#b65775",
  "#822111", "#a46a21", "#aa8831", "#076239", "#1a764d", "#1c4587", "#41236d", "#83334c",
  "#464646", "#e7e7e7", "#0d3472", "#b6cff5", "#0d3b44", "#98d7e4", "#3d188e", "#e3d7ff",
  "#711a36", "#fbd3e0", "#8a1c0a", "#f2b2a8", "#7a2e0b", "#ffc8af", "#7a4706", "#ffdeb5",
  "#594c05", "#fbe983", "#684e07", "#fdedc1", "#0b4f30", "#b3efd3", "#04502e", "#a2dcc1",
  "#c2c2c2", "#4986e7", "#2da2bb", "#b99aff", "#994a64", "#f691b2", "#ff7537", "#ffad46",
  "#662e37", "#ebdbde", "#cca6ac", "#094228", "#42d692", "#16a765",
]);

function validateColor(label: string, value: string | undefined): void {
  if (value === undefined) return;
  if (!ALLOWED_LABEL_COLORS.has(value.toLowerCase())) {
    throw new GmailError(
      `${label} "${value}" is not in Gmail's allowed label palette. ` +
        "Use one of Gmail's predefined hex colors (see the create_label tool description / README).",
    );
  }
}

function colorObject(
  textColor?: string,
  backgroundColor?: string,
): gmail_v1.Schema$LabelColor | undefined {
  validateColor("textColor", textColor);
  validateColor("backgroundColor", backgroundColor);
  // Gmail requires BOTH fields together when setting a custom color.
  if (textColor || backgroundColor) {
    if (!(textColor && backgroundColor)) {
      throw new GmailError(
        "Both textColor and backgroundColor must be provided together when coloring a label.",
      );
    }
    return { textColor, backgroundColor };
  }
  return undefined;
}

export async function createLabel(
  auth: OAuth2Client,
  ctx: AccountCtx,
  params: { name: string; textColor?: string; backgroundColor?: string },
): Promise<{ account: string; label: LabelInfo }> {
  const gmail = gmailClient(auth);
  const color = colorObject(params.textColor, params.backgroundColor);
  const res = await withRetry(() =>
    gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name: params.name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
        ...(color ? { color } : {}),
      },
    }),
  );
  return { account: ctx.alias, label: toLabelInfo(res.data) };
}

export async function updateLabel(
  auth: OAuth2Client,
  ctx: AccountCtx,
  params: { labelId: string; name?: string; textColor?: string; backgroundColor?: string },
): Promise<{ account: string; label: LabelInfo }> {
  const gmail = gmailClient(auth);
  const color = colorObject(params.textColor, params.backgroundColor);
  const requestBody: gmail_v1.Schema$Label = {};
  if (params.name !== undefined) requestBody.name = params.name;
  if (color) requestBody.color = color;
  if (Object.keys(requestBody).length === 0) {
    throw new GmailError("Nothing to update: provide a new name and/or colors.");
  }
  const res = await withRetry(() =>
    gmail.users.labels.patch({ userId: "me", id: params.labelId, requestBody }),
  );
  return { account: ctx.alias, label: toLabelInfo(res.data) };
}

export async function deleteLabel(
  auth: OAuth2Client,
  ctx: AccountCtx,
  params: { labelId: string },
): Promise<{ account: string; deletedLabelId: string }> {
  const gmail = gmailClient(auth);
  // Refuse to delete system labels. Fetch first to determine the type.
  const existing = await withRetry(() =>
    gmail.users.labels.get({ userId: "me", id: params.labelId }),
  );
  if ((existing.data.type ?? "user") === "system") {
    throw new GmailError(
      `Refusing to delete system label "${existing.data.name ?? params.labelId}". ` +
        "Only user-defined labels can be deleted.",
    );
  }
  await withRetry(() => gmail.users.labels.delete({ userId: "me", id: params.labelId }));
  return { account: ctx.alias, deletedLabelId: params.labelId };
}


// ---------------------------------------------------------------------------
// Label / unlabel messages & threads
// ---------------------------------------------------------------------------

export async function modifyMessageLabels(
  auth: OAuth2Client,
  ctx: AccountCtx,
  params: { messageId: string; addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<{ account: string; messageId: string; labelIds: string[] }> {
  const add = params.addLabelIds ?? [];
  const remove = params.removeLabelIds ?? [];
  if (add.length === 0 && remove.length === 0) {
    throw new GmailError("Provide at least one of addLabelIds or removeLabelIds.");
  }
  const gmail = gmailClient(auth);
  const res = await withRetry(() =>
    gmail.users.messages.modify({
      userId: "me",
      id: params.messageId,
      requestBody: {
        ...(add.length ? { addLabelIds: add } : {}),
        ...(remove.length ? { removeLabelIds: remove } : {}),
      },
    }),
  );
  return { account: ctx.alias, messageId: params.messageId, labelIds: res.data.labelIds ?? [] };
}

export async function modifyThreadLabels(
  auth: OAuth2Client,
  ctx: AccountCtx,
  params: { threadId: string; addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<{ account: string; threadId: string }> {
  const add = params.addLabelIds ?? [];
  const remove = params.removeLabelIds ?? [];
  if (add.length === 0 && remove.length === 0) {
    throw new GmailError("Provide at least one of addLabelIds or removeLabelIds.");
  }
  const gmail = gmailClient(auth);
  await withRetry(() =>
    gmail.users.threads.modify({
      userId: "me",
      id: params.threadId,
      requestBody: {
        ...(add.length ? { addLabelIds: add } : {}),
        ...(remove.length ? { removeLabelIds: remove } : {}),
      },
    }),
  );
  return { account: ctx.alias, threadId: params.threadId };
}

// ---------------------------------------------------------------------------
// Trash / spam
// ---------------------------------------------------------------------------

export type Target = { kind: "message"; id: string } | { kind: "thread"; id: string };

function targetResult(ctx: AccountCtx, t: Target, extra: Record<string, unknown>) {
  return {
    account: ctx.alias,
    ...(t.kind === "message" ? { messageId: t.id } : { threadId: t.id }),
    ...extra,
  };
}

/** Move a message or thread to Trash (soft delete, recoverable for 30 days). */
export async function trash(auth: OAuth2Client, ctx: AccountCtx, t: Target) {
  const gmail = gmailClient(auth);
  const res =
    t.kind === "message"
      ? await withRetry(() => gmail.users.messages.trash({ userId: "me", id: t.id }))
      : await withRetry(() => gmail.users.threads.trash({ userId: "me", id: t.id }));
  const labelIds = "labelIds" in res.data ? res.data.labelIds : undefined;
  return targetResult(ctx, t, { trashed: true, ...(labelIds ? { labelIds } : {}) });
}

/** Remove a message or thread from Trash (does not re-add INBOX). */
export async function untrash(auth: OAuth2Client, ctx: AccountCtx, t: Target) {
  const gmail = gmailClient(auth);
  const res =
    t.kind === "message"
      ? await withRetry(() => gmail.users.messages.untrash({ userId: "me", id: t.id }))
      : await withRetry(() => gmail.users.threads.untrash({ userId: "me", id: t.id }));
  const labelIds = "labelIds" in res.data ? res.data.labelIds : undefined;
  return targetResult(ctx, t, { trashed: false, ...(labelIds ? { labelIds } : {}) });
}

/** Mark as spam: add SPAM and remove INBOX, as Gmail's "Report spam" does. */
export async function markSpam(auth: OAuth2Client, ctx: AccountCtx, t: Target) {
  const change = { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] };
  if (t.kind === "message") {
    const r = await modifyMessageLabels(auth, ctx, { messageId: t.id, ...change });
    return targetResult(ctx, t, { spam: true, labelIds: r.labelIds });
  }
  await modifyThreadLabels(auth, ctx, { threadId: t.id, ...change });
  return targetResult(ctx, t, { spam: true });
}

/** Unmark spam: remove SPAM only (does not re-add INBOX), matching the connector. */
export async function unmarkSpam(auth: OAuth2Client, ctx: AccountCtx, t: Target) {
  if (t.kind === "message") {
    const r = await modifyMessageLabels(auth, ctx, { messageId: t.id, removeLabelIds: ["SPAM"] });
    return targetResult(ctx, t, { spam: false, labelIds: r.labelIds });
  }
  await modifyThreadLabels(auth, ctx, { threadId: t.id, removeLabelIds: ["SPAM"] });
  return targetResult(ctx, t, { spam: false });
}

/** apply_sensitive_*_label: TRASH -> trash, SPAM -> mark spam. */
export async function applySensitiveLabel(
  auth: OAuth2Client,
  ctx: AccountCtx,
  t: Target,
  labelOption: string,
) {
  if (labelOption === "TRASH") return trash(auth, ctx, t);
  if (labelOption === "SPAM") return markSpam(auth, ctx, t);
  throw new GmailError('labelOption must be "TRASH" or "SPAM".');
}
