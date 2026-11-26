/**
 * Pure helpers for turning Gmail message content into model-friendly text:
 *   - HTML -> plain text/markdown (keeps link URLs, decodes entities)
 *   - UTF-8-safe byte slicing for paginating long bodies
 *   - HTML escaping / reply quoting for drafts
 *
 * Kept free of API calls so it is unit-testable.
 */

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  sbquo: "‚", bdquo: "„", ndash: "–", mdash: "—",
  hellip: "…", bull: "•", middot: "·", copy: "©",
  reg: "®", trade: "™", euro: "€", pound: "£",
  yen: "¥", cent: "¢", deg: "°", times: "×",
  divide: "÷", laquo: "«", raquo: "»", zwnj: "‌",
  zwj: "‍", shy: "­", ensp: " ", emsp: " ",
  thinsp: " ", iexcl: "¡", iquest: "¿", sect: "§",
  para: "¶", hearts: "♥", rarr: "→", larr: "←",
  eacute: "é", egrave: "è", aacute: "á", agrave: "à",
  oacute: "ó", uacute: "ú", iacute: "í", ntilde: "ñ",
  uuml: "ü", ouml: "ö", auml: "ä", ccedil: "ç", szlig: "ß",
};

/** Decode numeric (&#123; &#x1F;) and common named HTML entities. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X"
          ? Number.parseInt(ent.slice(2), 16)
          : Number.parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[ent.toLowerCase()];
    return named ?? match;
  });
}

/**
 * Convert HTML to readable plain text with light markdown: links become
 * `[text](url)` (or just the URL when the text is the URL), images with alt
 * text become `[image: alt]`, list items become `- item`.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, "");

  // Links: keep the destination URL.
  s = s.replace(/<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, _q, dq, sq, bare, inner) => {
      const href = decodeEntities(String(dq ?? sq ?? bare ?? "").trim());
      const text = decodeEntities(String(inner).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
      if (!href || /^(javascript:|#)/i.test(href)) return text;
      const bareHref = href.replace(/^mailto:/i, "");
      if (!text || text === href || text === bareHref) return bareHref;
      return `[${text}](${href})`;
    });

  s = s.replace(/<img\b[^>]*?\balt\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi, (_m, _q, dq, sq) => {
    const alt = String(dq ?? sq ?? "").trim();
    return alt ? `[image: ${alt}]` : "";
  });

  s = s
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|tr|h[1-6]|blockquote|table|ul|ol)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, "");

  s = decodeEntities(s)
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface Utf8Slice {
  text: string;
  totalBytes: number;
  /** Byte offset to pass back to continue reading, when more remains. */
  nextOffset?: number;
}

/**
 * Return up to `maxBytes` of `text` starting at byte `offset`, never splitting
 * a multi-byte UTF-8 character at either end.
 */
export function sliceUtf8(text: string, offset: number, maxBytes: number): Utf8Slice {
  const buf = Buffer.from(text, "utf8");
  const total = buf.length;
  let start = Math.max(0, Math.min(offset | 0, total));
  // Move forward off any continuation byte (10xxxxxx).
  while (start < total && (buf[start]! & 0xc0) === 0x80) start++;
  let end = Math.min(start + maxBytes, total);
  if (end < total) {
    while (end > start && (buf[end]! & 0xc0) === 0x80) end--;
  }
  const out: Utf8Slice = { text: buf.subarray(start, end).toString("utf8"), totalBytes: total };
  if (end < total) out.nextOffset = end;
  return out;
}

/** Plain-text reply quote: attribution line + "> "-prefixed original. */
export function quotePlain(attribution: string, original: string): string {
  const quoted = original
    .replace(/\r\n/g, "\n")
    .trimEnd()
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
  return `${attribution}\n${quoted}`;
}

/** Gmail-style HTML reply quote. `originalHtml` is trusted as-is. */
export function quoteHtml(attribution: string, originalHtml: string): string {
  return (
    `<div class="gmail_quote"><div class="gmail_attr">${escapeHtml(attribution)}<br></div>` +
    `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">` +
    `${originalHtml}</blockquote></div>`
  );
}

/** Plain text -> minimal HTML (escaped, newlines as <br>). */
export function plainToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

export interface ParsedAddress {
  email: string;
  name?: string;
}

/**
 * Parse an RFC 5322 address-list header ("A <a@x>, \"Doe, J\" <j@x>, b@y")
 * into addresses. Commas inside quotes, angle brackets, or comments don't split;
 * group syntax ("Team: a@x, b@y;", "undisclosed-recipients:;") yields its members.
 */
export function parseAddressList(value: string): ParsedAddress[] {
  const parts: string[] = [];
  let cur = "";
  let inQuote = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\\" && inQuote) {
      cur += ch + (value[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"' && !angle && !paren) inQuote = !inQuote;
    else if (!inQuote) {
      if (ch === "<") angle++;
      else if (ch === ">" && angle) angle--;
      else if (ch === "(") paren++;
      else if (ch === ")" && paren) paren--;
      else if ((ch === "," || ch === ";") && !angle && !paren) {
        // ";" ends an RFC 5322 group ("Team: a@x, b@y;").
        parts.push(cur);
        cur = "";
        continue;
      } else if (ch === ":" && !angle && !paren && !cur.includes("@")) {
        // Group display name ("undisclosed-recipients:") — not an address.
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  parts.push(cur);

  const out: ParsedAddress[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(.*?)<([^>]*)>\s*(\(.*\))?$/);
    if (m) {
      const email = m[2]!.trim();
      if (!email) continue;
      const name = m[1]!.trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim();
      out.push(name ? { email, name } : { email });
    } else {
      // Bare address, possibly with a trailing "(Comment Name)".
      const c = part.match(/^(\S+@\S+?)\s*\((.*)\)$/);
      if (c) out.push(c[2]!.trim() ? { email: c[1]!, name: c[2]!.trim() } : { email: c[1]! });
      else out.push({ email: part });
    }
  }
  return out;
}
