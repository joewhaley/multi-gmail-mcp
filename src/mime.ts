/**
 * RFC 2822 / MIME message construction for create_draft.
 *
 * Produces a base64url-encoded raw message suitable for the Gmail API's
 * `raw` field. Structure is chosen by content:
 *
 *   plain only                      -> text/plain
 *   plain + html                    -> multipart/alternative
 *   + inline attachments            -> multipart/related [ alternative, inline... ]
 *   + regular attachments           -> multipart/mixed   [ body, attachment... ]
 *
 * Header text and bodies are UTF-8 safe: non-ASCII subjects use RFC 2047
 * encoded-words and all text bodies are base64-encoded.
 */

export interface MimeAttachment {
  filename?: string;
  mimeType?: string;
  /** base64-encoded file content. */
  content: string;
  inline?: boolean;
}

export interface MimeOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  /** Plain-text body (becomes the text/plain alternative when html is present). */
  body?: string;
  /** HTML body (rich-text alternative). */
  htmlBody?: string;
  attachments?: MimeAttachment[];
  /** RFC 822 Message-ID of the message being replied to (sets In-Reply-To). */
  inReplyTo?: string;
  /** References header value for threading. */
  references?: string;
  /** Injectable boundary generator (deterministic in tests). */
  boundaryFactory?: () => string;
}

const CRLF = "\r\n";

let boundaryCounter = 0;
function defaultBoundary(): string {
  boundaryCounter += 1;
  const rand = Math.random().toString(36).slice(2);
  return `=_mgm_${boundaryCounter}_${rand}`;
}

/** Encode a header value as an RFC 2047 encoded-word if it contains non-ASCII. */
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const b64 = Buffer.from(value, "utf8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}

/** base64url with padding stripped — the form Gmail's `raw` field expects. */
export function toBase64Url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Wrap a base64 string to 76-character lines (RFC 2045). */
function chunk76(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join(CRLF);
}

function addressList(addresses?: string[]): string | undefined {
  if (!addresses || addresses.length === 0) return undefined;
  return addresses.map((a) => a.trim()).filter(Boolean).join(", ");
}

/** A text part encoded as base64 (handles UTF-8 and long lines safely). */
function textPart(mimeType: string, text: string): string {
  const headers = [
    `Content-Type: ${mimeType}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
  ];
  const b64 = chunk76(Buffer.from(text, "utf8").toString("base64"));
  return headers.join(CRLF) + CRLF + CRLF + b64;
}

function attachmentPart(att: MimeAttachment): string {
  const mimeType = att.mimeType || "application/octet-stream";
  const filename = att.filename || "attachment";
  const disposition = att.inline ? "inline" : "attachment";
  const headers = [
    `Content-Type: ${mimeType}; name="${filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${disposition}; filename="${filename}"`,
  ];
  if (att.inline) {
    // A stable Content-ID lets HTML reference inline images via cid:<filename>.
    headers.push(`Content-ID: <${filename}>`);
  }
  // Re-chunk the provided base64 so line lengths are RFC-compliant regardless
  // of how the caller encoded it.
  const normalized = att.content.replace(/\s+/g, "");
  return headers.join(CRLF) + CRLF + CRLF + chunk76(normalized);
}

function multipart(subtype: string, boundary: string, parts: string[]): string {
  const head = `Content-Type: multipart/${subtype}; boundary="${boundary}"`;
  const body = parts.map((p) => `--${boundary}${CRLF}${p}`).join(CRLF) + `${CRLF}--${boundary}--`;
  return head + CRLF + CRLF + body;
}

/**
 * Build a complete raw MIME message and return it base64url-encoded.
 * `boundaryFactory` may be injected for deterministic output in tests.
 */
export function buildMimeMessage(opts: MimeOptions): string {
  const newBoundary = opts.boundaryFactory ?? defaultBoundary;

  const toLine = addressList(opts.to);
  if (!toLine) throw new Error("At least one recipient is required in `to`.");

  const headers: string[] = [`To: ${toLine}`];
  const cc = addressList(opts.cc);
  if (cc) headers.push(`Cc: ${cc}`);
  const bcc = addressList(opts.bcc);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  headers.push(`Subject: ${encodeHeaderValue(opts.subject ?? "")}`);
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) headers.push(`References: ${opts.references}`);
  headers.push("MIME-Version: 1.0");

  const plain = opts.body ?? "";
  const html = opts.htmlBody;

  // 1) Build the "body" part (text, or alternative of text+html).
  let bodyPart: string;
  if (html && plain) {
    const altBoundary = newBoundary();
    bodyPart = multipart("alternative", altBoundary, [
      textPart("text/plain", plain),
      textPart("text/html", html),
    ]);
  } else if (html) {
    bodyPart = textPart("text/html", html);
  } else {
    bodyPart = textPart("text/plain", plain);
  }

  // 2) Layer in attachments.
  const attachments = opts.attachments ?? [];
  const inline = attachments.filter((a) => a.inline);
  const regular = attachments.filter((a) => !a.inline);

  let payload = bodyPart;
  if (inline.length > 0) {
    const relBoundary = newBoundary();
    payload = multipart("related", relBoundary, [payload, ...inline.map(attachmentPart)]);
  }
  if (regular.length > 0) {
    const mixedBoundary = newBoundary();
    payload = multipart("mixed", mixedBoundary, [payload, ...regular.map(attachmentPart)]);
  }

  const raw = headers.join(CRLF) + CRLF + payload;
  return toBase64Url(raw);
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Validate that combined (decoded) attachment size is within Gmail's 25MB limit. */
export function assertAttachmentSize(attachments?: MimeAttachment[]): void {
  if (!attachments || attachments.length === 0) return;
  let total = 0;
  for (const att of attachments) {
    const normalized = att.content.replace(/\s+/g, "");
    // base64 decodes to ~3/4 of its length (minus padding).
    const padding = (normalized.match(/=+$/)?.[0].length ?? 0);
    total += Math.floor((normalized.length * 3) / 4) - padding;
  }
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Combined attachment size (~${Math.round(total / 1024 / 1024)}MB) exceeds the 25MB limit. ` +
        "Upload large files to Drive and link them in the body instead.",
    );
  }
}
