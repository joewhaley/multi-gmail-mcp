import { describe, it, expect } from "vitest";
import {
  htmlToText,
  decodeEntities,
  sliceUtf8,
  quotePlain,
  quoteHtml,
  plainToHtml,
  formatQuoteDate,
  replyAttribution,
} from "../src/content.js";
import { extractContent, normalizeFormat, normalizeThreadView, searchCount } from "../src/gmail.js";

const b64url = (s: string) =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

describe("htmlToText", () => {
  it("keeps link destinations as markdown", () => {
    expect(htmlToText('See <a href="https://x.com/a?b=1&amp;c=2">the report</a>.')).toBe(
      "See [the report](https://x.com/a?b=1&c=2).",
    );
  });

  it("collapses links whose text is the URL, and strips mailto:", () => {
    expect(htmlToText('<a href="https://x.com">https://x.com</a>')).toBe("https://x.com");
    expect(htmlToText('<a href="mailto:a@b.com">a@b.com</a>')).toBe("a@b.com");
  });

  it("decodes numeric and named entities", () => {
    expect(htmlToText("It&rsquo;s &#8220;fine&#x201D; &mdash; ok&nbsp;&amp; done")).toBe(
      "It’s “fine” — ok & done",
    );
  });

  it("drops style/script/comments and renders list items", () => {
    const html =
      "<style>p{}</style><!-- hi --><script>x()</script><ul><li>one</li><li>two</li></ul>";
    expect(htmlToText(html)).toBe("- one\n- two");
  });

  it("does not double-decode &amp;lt;", () => {
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });

  it("keeps image alt text", () => {
    expect(htmlToText('<img src="x.png" alt="Logo">')).toBe("[image: Logo]");
  });
});

describe("htmlToText: whitespace inside end tags", () => {
  it("keeps adjacent links separate when </a> ends with a line break", () => {
    // From a real Starlink email: each end tag is written as "</a\n>".
    const html =
      '<p><a href="https://s.com/support">Support</a\n> | <a href="https://s.com/privacy">Privacy</a\n>' +
      ' | <a href="https://s.com/unsub">Unsubscribe</a\n></p\n><p>Footer</p >';
    expect(htmlToText(html)).toBe(
      "[Support](https://s.com/support) | [Privacy](https://s.com/privacy) | " +
        "[Unsubscribe](https://s.com/unsub)\nFooter",
    );
  });

  it("handles whitespace in </td>, </div> and <br> with attributes", () => {
    expect(htmlToText("<table><tr><td>a</td\n><td>b</td ></tr\n></table>")).toBe("a\tb");
    expect(htmlToText("<div>one</div\t>two<br class=\"x\">three")).toBe("one\ntwo\nthree");
  });

  it("drops <style> blocks whose end tag has whitespace", () => {
    expect(htmlToText("<style>p{}</style\n>hi")).toBe("hi");
  });
});

describe("reply attribution", () => {
  const d = new Date("2026-11-25T23:04:00Z");
  it("formats a Gmail-style date in the given zone", () => {
    expect(formatQuoteDate(d, "America/Los_Angeles")).toBe("Wed, Nov 25, 2026 at 3:04 PM");
    expect(formatQuoteDate(d, "UTC")).toBe("Wed, Nov 25, 2026 at 11:04 PM");
  });
  it("builds the attribution line, falling back to the raw header", () => {
    expect(replyAttribution("A <a@b.com>", d, "raw", "UTC")).toBe(
      "On Wed, Nov 25, 2026 at 11:04 PM A <a@b.com> wrote:",
    );
    expect(replyAttribution("A", new Date("nope"), "Tue, 1 Jan 2030")).toBe("On Tue, 1 Jan 2030 A wrote:");
    expect(replyAttribution("A", undefined, "")).toBe("A wrote:");
  });
});

describe("searchCount", () => {
  it("is exact when everything fits on the first page", () => {
    expect(searchCount(32, 201, false, false)).toEqual({ resultCountEstimate: "32" });
    expect(searchCount(0, 0, false, false)).toEqual({ resultCountEstimate: "0" });
  });
  it("treats Gmail's 201/702 placeholder as unknown", () => {
    expect(searchCount(1, 201, false, true)).toBeNull();
    expect(searchCount(500, 702, false, true)).toBeNull();
  });
  it("trusts small estimates", () => {
    expect(searchCount(20, 32, false, true)).toEqual({ resultCountEstimate: "32" });
  });
  it("never reports fewer than were returned", () => {
    expect(searchCount(20, 5, true, false)).toEqual({ resultCountEstimate: "20" });
  });
});

describe("sliceUtf8", () => {
  it("never splits a multi-byte character", () => {
    const text = "aé€😀b"; // 1 + 2 + 3 + 4 + 1 bytes
    const first = sliceUtf8(text, 0, 5); // would land mid-€
    expect(first.text).toBe("aé");
    expect(first.nextOffset).toBe(3);
    const rest = sliceUtf8(text, first.nextOffset!, 100);
    expect(rest.text).toBe("€😀b");
    expect(rest.nextOffset).toBeUndefined();
    expect(first.totalBytes).toBe(11);
  });

  it("pages through a long body losslessly", () => {
    const text = "héllo wörld ".repeat(1000);
    let offset: number | undefined = 0;
    let out = "";
    while (offset !== undefined) {
      const s = sliceUtf8(text, offset, 97);
      out += s.text;
      offset = s.nextOffset;
    }
    expect(out).toBe(text);
  });
});

describe("reply quoting", () => {
  it("prefixes plain lines with >", () => {
    expect(quotePlain("On X, A wrote:", "hi\n\nthere\n")).toBe("On X, A wrote:\n> hi\n>\n> there");
  });
  it("wraps HTML in a gmail_quote blockquote and escapes the attribution", () => {
    const q = quoteHtml("On X, A <a@b.com> wrote:", "<p>hi</p>");
    expect(q).toContain("A &lt;a@b.com&gt; wrote:");
    expect(q).toContain("<blockquote");
    expect(q).toContain("<p>hi</p>");
  });
  it("converts plain text to escaped HTML", () => {
    expect(plainToHtml("a<b\nc")).toBe("a&lt;b<br>c");
  });
});

describe("extractContent", () => {
  const fakeGmail = (attachments: Record<string, string> = {}) =>
    ({
      users: {
        messages: {
          attachments: {
            get: async ({ id }: { id: string }) => ({ data: { data: attachments[id] } }),
          },
        },
      },
    }) as any;

  it("fetches text bodies stored out-of-line instead of returning empty", async () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [{ mimeType: "text/plain", body: { attachmentId: "big1", size: 900000 } }],
    };
    const c = await extractContent(fakeGmail({ big1: b64url("large body") }), "m1", payload);
    expect(c.plain).toBe("large body");
    expect(c.attachments).toEqual([]);
  });

  it("treats named or attachment-disposition text parts as files, not body", async () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("the body") } },
        {
          mimeType: "text/plain",
          filename: "notes.txt",
          body: { data: b64url("file contents"), size: 13 },
        },
        {
          mimeType: "text/csv",
          headers: [{ name: "Content-Disposition", value: "attachment" }],
          body: { attachmentId: "a2", size: 50 },
        },
      ],
    };
    const c = await extractContent(fakeGmail(), "m1", payload);
    expect(c.plain).toBe("the body");
    expect(c.attachments.map((a) => a.filename)).toEqual(["notes.txt", "(unnamed)"]);
    expect(c.attachments[1]!.attachmentId).toBe("a2");
  });

  it("lists unnamed inline images with their Content-ID", async () => {
    const payload = {
      mimeType: "multipart/related",
      parts: [
        { mimeType: "text/html", body: { data: b64url("<img src=cid:logo>") } },
        {
          mimeType: "image/png",
          headers: [
            { name: "Content-Disposition", value: "inline" },
            { name: "Content-ID", value: "<logo>" },
          ],
          body: { attachmentId: "img1", size: 10 },
        },
      ],
    };
    const c = await extractContent(fakeGmail(), "m1", payload);
    expect(c.html).toContain("cid:logo");
    expect(c.attachments).toEqual([
      expect.objectContaining({ attachmentId: "img1", inline: true, contentId: "logo" }),
    ]);
  });
});

describe("format normalization", () => {
  it("defaults to PLAIN_TEXT", () => {
    expect(normalizeFormat()).toBe("PLAIN_TEXT");
    expect(normalizeFormat("MESSAGE_FORMAT_UNSPECIFIED")).toBe("PLAIN_TEXT");
    expect(normalizeFormat("RAW")).toBe("RAW");
  });
  it("maps connector thread views", () => {
    expect(normalizeThreadView("THREAD_VIEW_UNSPECIFIED")).toBe("MINIMAL");
    expect(normalizeThreadView("THREAD_VIEW_IDS_ONLY")).toBe("IDS_ONLY");
    expect(normalizeThreadView("THREAD_VIEW_SUMMARY")).toBe("SUMMARY");
  });
});

describe("extractContent: attached emails", () => {
  const gmail = { users: { messages: { attachments: { get: async () => ({ data: {} }) } } } } as any;
  it("does not merge a forwarded message/rfc822 into the body", async () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("Outer.") } },
        {
          mimeType: "message/rfc822",
          filename: "",
          body: { size: 100 },
          parts: [{ mimeType: "text/plain", body: { data: b64url("INNER") } }],
        },
      ],
    };
    const c = await extractContent(gmail, "m", payload);
    expect(c.plain).toBe("Outer.");
    expect(c.attachments.map((a) => a.filename)).toEqual(["attached-message.eml"]);
  });
});

describe("parseAddressList", () => {
  it("handles quoted commas, comments, escaped quotes, groups, and bare angles", async () => {
    const { parseAddressList } = await import("../src/content.js");
    expect(
      parseAddressList(
        '"Doe, Jane" <jane@x.com>, bob@x.com (Bob Smith), undisclosed-recipients:;, ' +
          '"Q \\"Z\\"" <q@x.com>, <angle@x.com>',
      ),
    ).toEqual([
      { email: "jane@x.com", name: "Doe, Jane" },
      { email: "bob@x.com", name: "Bob Smith" },
      { email: "q@x.com", name: 'Q "Z"' },
      { email: "angle@x.com" },
    ]);
  });
  it("handles named groups with members", async () => {
    const { parseAddressList } = await import("../src/content.js");
    expect(parseAddressList("Team: a@x.com, B <b@x.com>;").map((a) => a.email)).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
  });
});
