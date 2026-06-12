import { describe, it, expect } from "vitest";
import { buildSearchQuery } from "../src/gmail.js";

describe("buildSearchQuery", () => {
  it("excludes drafts by default when no query is given", () => {
    expect(buildSearchQuery()).toBe("-in:draft");
    expect(buildSearchQuery("")).toBe("-in:draft");
  });

  it("passes Gmail operators through verbatim and appends -in:draft", () => {
    expect(buildSearchQuery("from:amy@x.com newer_than:7d")).toBe(
      "from:amy@x.com newer_than:7d -in:draft",
    );
  });

  it("preserves complex grouping and negation untouched", () => {
    const q = "subject:(invoice OR receipt) has:attachment -from:spam@x.com";
    expect(buildSearchQuery(q)).toBe(`${q} -in:draft`);
  });

  it("does not append -in:draft when the caller references drafts", () => {
    expect(buildSearchQuery("in:draft")).toBe("in:draft");
    expect(buildSearchQuery("-in:draft foo")).toBe("-in:draft foo");
  });

  it("widens to in:anywhere when includeTrash is true", () => {
    expect(buildSearchQuery("from:x@y.com", true)).toBe("from:x@y.com -in:draft in:anywhere");
  });

  it("does not duplicate folder scoping when includeTrash is true", () => {
    expect(buildSearchQuery("in:trash from:x@y.com", true)).toBe("in:trash from:x@y.com -in:draft");
    expect(buildSearchQuery("in:anywhere foo", true)).toBe("in:anywhere foo");
  });

  it("keeps trash excluded by default (includeTrash false)", () => {
    expect(buildSearchQuery("is:unread")).toBe("is:unread -in:draft");
  });

  it("trims surrounding whitespace", () => {
    expect(buildSearchQuery("  from:x@y.com  ")).toBe("from:x@y.com -in:draft");
  });
});
