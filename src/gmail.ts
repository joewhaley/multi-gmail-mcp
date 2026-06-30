/**
 * Thin, well-typed wrappers over the Gmail REST API (gmail.users.*), shared by
 * every tool. Responsibilities:
 *   - build/normalize search queries (draft + trash handling)
 *   - decode MIME parts into plain text + attachment metadata
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

/** ~50KB cap on returned body text before truncation. */
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
// Header / body decoding
// ---------------------------------------------------------------------------

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Strip HTML to readable-ish plain text (best-effort fallback). */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface DecodedBody {
  text: string;
  truncated: boolean;
  attachments: AttachmentMeta[];
}

interface AttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** Walk a message payload collecting the best body text and attachment metadata. */
function decodeMessageBody(payload: gmail_v1.Schema$MessagePart | undefined): DecodedBody {
  const attachments: AttachmentMeta[] = [];
  let plain = "";
  let html = "";

  const walk = (part: gmail_v1.Schema$MessagePart | undefined) => {
    if (!part) return;
    const mimeType = part.mimeType ?? "";
    const filename = part.filename ?? "";
    const body = part.body;

    if (body?.attachmentId && filename) {
      attachments.push({
        attachmentId: body.attachmentId,
        filename,
        mimeType: mimeType || "application/octet-stream",
        size: body.size ?? 0,
      });
    } else if (mimeType === "text/plain" && body?.data) {
      plain += decodeBase64Url(body.data).toString("utf8");
    } else if (mimeType === "text/html" && body?.data) {
      html += decodeBase64Url(body.data).toString("utf8");
    }

    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);

  let text = plain.trim() ? plain : htmlToText(html);
  let truncated = false;
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    text = Buffer.from(text, "utf8").subarray(0, MAX_BODY_BYTES).toString("utf8");
    truncated = true;
  }
  return { text, truncated, attachments };
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface MessageMeta {
  id: string;
  snippet: string;
  subject: string;
  from: string;
  to: string;
  cc?: string;
  date: string;
}

export interface ThreadSummary {
  threadId: string;
  messages: MessageMeta[];
}

export interface SearchThreadsResult {
  account: string;
  threads: ThreadSummary[];
  nextPageToken?: string;
  note: string;
}

function toMessageMeta(msg: gmail_v1.Schema$Message): MessageMeta {
  const h = msg.payload?.headers;
  const cc = header(h, "Cc");
  const meta: MessageMeta = {
    id: msg.id ?? "",
    snippet: msg.snippet ?? "",
    subject: header(h, "Subject"),
    from: header(h, "From"),
    to: header(h, "To"),
    date: header(h, "Date"),
  };
  if (cc) meta.cc = cc;
  return meta;
}

const META_HEADERS = ["Subject", "From", "To", "Cc", "Date"];

// ---------------------------------------------------------------------------
// search_threads
// ---------------------------------------------------------------------------

export async function searchThreads(
  auth: OAuth2Client,
  alias: string,
  params: { query?: string; pageSize?: number; pageToken?: string; includeTrash?: boolean },
): Promise<SearchThreadsResult> {
  const gmail = gmailClient(auth);
  const q = buildSearchQuery(params.query, params.includeTrash);
  const maxResults = Math.min(Math.max(params.pageSize ?? 20, 1), 50);

  const list = await withRetry(() =>
    gmail.users.threads.list({
      userId: "me",
      q: q || undefined,
      maxResults,
      pageToken: params.pageToken || undefined,
    }),
  );

  const threadStubs = list.data.threads ?? [];
  // threads.list returns only ids/snippets; fetch lightweight per-message
  // metadata for each thread (bounded concurrency).
  const threads = await mapLimit(threadStubs, FANOUT_CONCURRENCY, async (stub) => {
    const detail = await withRetry(() =>
      gmail.users.threads.get({
        userId: "me",
        id: stub.id!,
        format: "metadata",
        metadataHeaders: META_HEADERS,
      }),
    );
    return {
      threadId: detail.data.id ?? stub.id ?? "",
      messages: (detail.data.messages ?? []).map(toMessageMeta),
    } satisfies ThreadSummary;
  });

  const result: SearchThreadsResult = {
    account: alias,
    threads,
    note: "Message bodies are not included. Use get_thread with a threadId to read full content.",
  };
  if (list.data.nextPageToken) result.nextPageToken = list.data.nextPageToken;
  return result;
}

// ---------------------------------------------------------------------------
// get_thread
// ---------------------------------------------------------------------------

export type MessageFormat = "MINIMAL" | "FULL_CONTENT";

export interface ThreadMessageFull extends MessageMeta {
  labelIds?: string[];
  body?: string;
  bodyTruncated?: boolean;
  attachments?: AttachmentMeta[];
}

export async function getThread(
  auth: OAuth2Client,
  alias: string,
  params: { threadId: string; messageFormat?: MessageFormat },
): Promise<{ account: string; threadId: string; messages: ThreadMessageFull[] }> {
  const gmail = gmailClient(auth);
  const full = (params.messageFormat ?? "FULL_CONTENT") === "FULL_CONTENT";

  const res = await withRetry(() =>
    gmail.users.threads.get({
      userId: "me",
      id: params.threadId,
      format: full ? "full" : "metadata",
      ...(full ? {} : { metadataHeaders: META_HEADERS }),
    }),
  );

  const messages = (res.data.messages ?? []).map((msg): ThreadMessageFull => {
    const base = toMessageMeta(msg);
    const out: ThreadMessageFull = { ...base };
    if (msg.labelIds) out.labelIds = msg.labelIds;
    if (full) {
      const decoded = decodeMessageBody(msg.payload);
      out.body = decoded.text;
      if (decoded.truncated) out.bodyTruncated = true;
      if (decoded.attachments.length > 0) out.attachments = decoded.attachments;
    }
    return out;
  });

  return { account: alias, threadId: res.data.id ?? params.threadId, messages };
}

// ---------------------------------------------------------------------------
// create_draft
// ---------------------------------------------------------------------------

export interface CreateDraftParams {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  replyToMessageId?: string;
  attachments?: MimeAttachment[];
}

export async function createDraft(
  auth: OAuth2Client,
  alias: string,
  params: CreateDraftParams,
): Promise<{ account: string; draftId: string; messageId?: string; threadId?: string }> {
  const gmail = gmailClient(auth);
  assertAttachmentSize(params.attachments);

  let inReplyTo: string | undefined;
  let references: string | undefined;
  let threadId: string | undefined;
  let subject = params.subject;

  if (params.replyToMessageId) {
    // Fetch the original to set proper threading headers and inherit subject.
    const original = await withRetry(() =>
      gmail.users.messages.get({
        userId: "me",
        id: params.replyToMessageId!,
        format: "metadata",
        metadataHeaders: ["Message-ID", "References", "Subject"],
      }),
    );
    const h = original.data.payload?.headers;
    const messageIdHeader = header(h, "Message-ID");
    const existingRefs = header(h, "References");
    const origSubject = header(h, "Subject");

    threadId = original.data.threadId ?? undefined;
    if (messageIdHeader) {
      inReplyTo = messageIdHeader;
      references = [existingRefs, messageIdHeader].filter(Boolean).join(" ").trim();
    }
    if (!subject && origSubject) {
      subject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
    }
  }

  const raw = buildMimeMessage({
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject,
    body: params.body,
    htmlBody: params.htmlBody,
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

  const out: { account: string; draftId: string; messageId?: string; threadId?: string } = {
    account: alias,
    draftId: res.data.id ?? "",
  };
  if (res.data.message?.id) out.messageId = res.data.message.id;
  if (res.data.message?.threadId) out.threadId = res.data.message.threadId;
  return out;
}

// ---------------------------------------------------------------------------
// list_drafts
// ---------------------------------------------------------------------------

export interface DraftSummary {
  draftId: string;
  messageId: string;
  subject: string;
  to: string;
  snippet: string;
}

export async function listDrafts(
  auth: OAuth2Client,
  alias: string,
  params: { pageSize?: number; pageToken?: string },
): Promise<{ account: string; drafts: DraftSummary[]; nextPageToken?: string }> {
  const gmail = gmailClient(auth);
  const maxResults = Math.min(Math.max(params.pageSize ?? 20, 1), 50);

  const list = await withRetry(() =>
    gmail.users.drafts.list({
      userId: "me",
      maxResults,
      pageToken: params.pageToken || undefined,
    }),
  );

  const stubs = list.data.drafts ?? [];
  const drafts = await mapLimit(stubs, FANOUT_CONCURRENCY, async (stub) => {
    const msg = await withRetry(() =>
      gmail.users.messages.get({
        userId: "me",
        id: stub.message!.id!,
        format: "metadata",
        metadataHeaders: ["Subject", "To"],
      }),
    );
    const h = msg.data.payload?.headers;
    return {
      draftId: stub.id ?? "",
      messageId: stub.message?.id ?? "",
      subject: header(h, "Subject"),
      to: header(h, "To"),
      snippet: msg.data.snippet ?? "",
    } satisfies DraftSummary;
  });

  const out: { account: string; drafts: DraftSummary[]; nextPageToken?: string } = {
    account: alias,
    drafts,
  };
  if (list.data.nextPageToken) out.nextPageToken = list.data.nextPageToken;
  return out;
}

// ---------------------------------------------------------------------------
// delete_draft
// ---------------------------------------------------------------------------

export async function deleteDraft(
  auth: OAuth2Client,
  alias: string,
  params: { draftId: string },
): Promise<{ account: string; deletedDraftId: string }> {
  const gmail = gmailClient(auth);
  // drafts.delete permanently removes the draft (it is NOT moved to Trash).
  // A missing draft surfaces as a 404, which describeGmailError maps cleanly.
  await withRetry(() => gmail.users.drafts.delete({ userId: "me", id: params.draftId }));
  return { account: alias, deletedDraftId: params.draftId };
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
  alias: string,
  params: { pageSize?: number; pageToken?: string },
): Promise<{ account: string; labels: LabelInfo[]; nextPageToken?: string; note: string }> {
  const gmail = gmailClient(auth);
  // Gmail's labels.list is not paginated server-side; it returns everything in
  // one call. We expose pageSize/pageToken for interface parity and paginate
  // client-side using a numeric offset token.
  const res = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
  const userLabels = (res.data.labels ?? [])
    .filter((l) => (l.type ?? "user") === "user")
    .map(toLabelInfo);

  const offset = Number.parseInt(params.pageToken ?? "0", 10) || 0;
  const pageSize = params.pageSize && params.pageSize > 0 ? params.pageSize : userLabels.length;
  const page = userLabels.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;

  const out: {
    account: string;
    labels: LabelInfo[];
    nextPageToken?: string;
    note: string;
  } = {
    account: alias,
    labels: page,
    note:
      "Only user-defined labels are listed. System labels can be used directly by well-known ID: " +
      "INBOX, TRASH, SPAM, STARRED, UNREAD, IMPORTANT, DRAFT, SENT.",
  };
  if (nextOffset < userLabels.length) out.nextPageToken = String(nextOffset);
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
  alias: string,
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
  return { account: alias, label: toLabelInfo(res.data) };
}

export async function updateLabel(
  auth: OAuth2Client,
  alias: string,
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
  return { account: alias, label: toLabelInfo(res.data) };
}

export async function deleteLabel(
  auth: OAuth2Client,
  alias: string,
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
  return { account: alias, deletedLabelId: params.labelId };
}

// ---------------------------------------------------------------------------
// Label / unlabel messages & threads
// ---------------------------------------------------------------------------

export async function modifyMessageLabels(
  auth: OAuth2Client,
  alias: string,
  params: { messageId: string; labelIds: string[]; add: boolean },
): Promise<{ account: string; messageId: string; labelIds: string[] }> {
  const gmail = gmailClient(auth);
  const res = await withRetry(() =>
    gmail.users.messages.modify({
      userId: "me",
      id: params.messageId,
      requestBody: params.add
        ? { addLabelIds: params.labelIds }
        : { removeLabelIds: params.labelIds },
    }),
  );
  return { account: alias, messageId: params.messageId, labelIds: res.data.labelIds ?? [] };
}

export async function modifyThreadLabels(
  auth: OAuth2Client,
  alias: string,
  params: { threadId: string; labelIds: string[]; add: boolean },
): Promise<{ account: string; threadId: string }> {
  const gmail = gmailClient(auth);
  await withRetry(() =>
    gmail.users.threads.modify({
      userId: "me",
      id: params.threadId,
      requestBody: params.add
        ? { addLabelIds: params.labelIds }
        : { removeLabelIds: params.labelIds },
    }),
  );
  return { account: alias, threadId: params.threadId };
}
