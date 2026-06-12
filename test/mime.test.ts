import { describe, it, expect } from "vitest";
import {
  buildMimeMessage,
  encodeHeaderValue,
  toBase64Url,
  assertAttachmentSize,
} from "../src/mime.js";

/** Decode the base64url raw message back to a UTF-8 string for assertions. */
function decode(raw: string): string {
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** Deterministic boundary generator: B1, B2, B3, ... */
function fixedBoundaries() {
  let n = 0;
  return () => `B${++n}`;
}

describe("encodeHeaderValue", () => {
  it("leaves ASCII untouched", () => {
    expect(encodeHeaderValue("Hello World")).toBe("Hello World");
  });
  it("RFC 2047 encodes non-ASCII", () => {
    expect(encodeHeaderValue("Café ☕")).toBe(`=?UTF-8?B?${Buffer.from("Café ☕", "utf8").toString("base64")}?=`);
  });
});

describe("toBase64Url", () => {
  it("produces URL-safe base64 with no padding", () => {
    const out = toBase64Url("hello??>>");
    expect(out).not.toMatch(/[+/=]/);
    expect(decode(out)).toBe("hello??>>");
  });
});

describe("buildMimeMessage", () => {
  it("builds a plain-text message with headers", () => {
    const raw = decode(
      buildMimeMessage({ to: ["a@x.com"], subject: "Hi", body: "Hello there" }),
    );
    expect(raw).toMatch(/^To: a@x\.com\r\n/m);
    expect(raw).toMatch(/Subject: Hi\r\n/);
    expect(raw).toMatch(/MIME-Version: 1\.0/);
    expect(raw).toMatch(/Content-Type: text\/plain; charset="UTF-8"/);
    // base64 body decodes to the original text
    const b64 = raw.split("\r\n\r\n").pop()!.trim();
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("Hello there");
  });

  it("joins multiple recipients and includes cc/bcc", () => {
    const raw = decode(
      buildMimeMessage({
        to: ["a@x.com", "b@x.com"],
        cc: ["c@x.com"],
        bcc: ["d@x.com"],
        body: "x",
      }),
    );
    expect(raw).toMatch(/To: a@x\.com, b@x\.com/);
    expect(raw).toMatch(/Cc: c@x\.com/);
    expect(raw).toMatch(/Bcc: d@x\.com/);
  });

  it("uses multipart/alternative when both text and html are present", () => {
    const raw = decode(
      buildMimeMessage({
        to: ["a@x.com"],
        body: "plain",
        htmlBody: "<b>rich</b>",
        boundaryFactory: fixedBoundaries(),
      }),
    );
    expect(raw).toMatch(/Content-Type: multipart\/alternative; boundary="B1"/);
    expect(raw).toMatch(/Content-Type: text\/plain; charset="UTF-8"/);
    expect(raw).toMatch(/Content-Type: text\/html; charset="UTF-8"/);
    expect(raw).toMatch(/--B1--/);
  });

  it("wraps regular attachments in multipart/mixed", () => {
    const raw = decode(
      buildMimeMessage({
        to: ["a@x.com"],
        body: "see attached",
        attachments: [
          { filename: "f.txt", mimeType: "text/plain", content: Buffer.from("data").toString("base64") },
        ],
        boundaryFactory: fixedBoundaries(),
      }),
    );
    expect(raw).toMatch(/Content-Type: multipart\/mixed; boundary="B1"/);
    expect(raw).toMatch(/Content-Disposition: attachment; filename="f\.txt"/);
    expect(raw).toMatch(/Content-Type: text\/plain; name="f\.txt"/);
  });

  it("wraps inline attachments in multipart/related with a Content-ID", () => {
    const raw = decode(
      buildMimeMessage({
        to: ["a@x.com"],
        htmlBody: '<img src="cid:logo.png">',
        attachments: [
          { filename: "logo.png", mimeType: "image/png", content: "AAAA", inline: true },
        ],
        boundaryFactory: fixedBoundaries(),
      }),
    );
    expect(raw).toMatch(/Content-Type: multipart\/related; boundary="B1"/);
    expect(raw).toMatch(/Content-Disposition: inline; filename="logo\.png"/);
    expect(raw).toMatch(/Content-ID: <logo\.png>/);
  });

  it("sets reply headers when provided", () => {
    const raw = decode(
      buildMimeMessage({
        to: ["a@x.com"],
        subject: "Re: Hi",
        body: "reply",
        inReplyTo: "<orig@mail.gmail.com>",
        references: "<root@mail.gmail.com> <orig@mail.gmail.com>",
      }),
    );
    expect(raw).toMatch(/In-Reply-To: <orig@mail\.gmail\.com>/);
    expect(raw).toMatch(/References: <root@mail\.gmail\.com> <orig@mail\.gmail\.com>/);
  });

  it("RFC 2047 encodes a non-ASCII subject", () => {
    const raw = decode(buildMimeMessage({ to: ["a@x.com"], subject: "Déjà vu", body: "x" }));
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
  });

  it("throws when no recipient is given", () => {
    expect(() => buildMimeMessage({ to: [], body: "x" })).toThrowError(/recipient/i);
  });
});

describe("assertAttachmentSize", () => {
  it("allows small attachments", () => {
    expect(() => assertAttachmentSize([{ content: Buffer.from("hi").toString("base64") }])).not.toThrow();
  });
  it("rejects combined attachments over 25MB", () => {
    // 26MB of base64 (~34.7MB of base64 chars decodes to 26MB)
    const big = "A".repeat(Math.ceil((26 * 1024 * 1024 * 4) / 3));
    expect(() => assertAttachmentSize([{ content: big }])).toThrowError(/25MB/);
  });
});
