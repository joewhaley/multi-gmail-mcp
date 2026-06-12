import { describe, it, expect } from "vitest";
import { resolveAccount, formatAccountList, type AccountsFile } from "../src/accounts.js";

const multi: AccountsFile = {
  accounts: {
    work: { email: "me@company.com", refresh_token: "r1", default: true },
    personal: { email: "me@gmail.com", refresh_token: "r2" },
  },
};

const single: AccountsFile = {
  accounts: { solo: { email: "solo@example.com", refresh_token: "r" } },
};

describe("resolveAccount", () => {
  it("uses the default account when no account is given", () => {
    expect(resolveAccount(multi).alias).toBe("work");
  });

  it("uses the only account when there is exactly one and no default flag", () => {
    expect(resolveAccount(single).alias).toBe("solo");
  });

  it("errors when multiple accounts exist and none is default", () => {
    const data: AccountsFile = {
      accounts: {
        a: { email: "a@x.com", refresh_token: "1" },
        b: { email: "b@x.com", refresh_token: "2" },
      },
    };
    expect(() => resolveAccount(data)).toThrowError(/multiple accounts/i);
  });

  it("resolves an alias case-insensitively", () => {
    expect(resolveAccount(multi, "PERSONAL").alias).toBe("personal");
    expect(resolveAccount(multi, "Personal").alias).toBe("personal");
  });

  it("resolves by email address (case-insensitive)", () => {
    expect(resolveAccount(multi, "ME@Gmail.com").alias).toBe("personal");
  });

  it("prefers alias match over email match", () => {
    const data: AccountsFile = {
      accounts: {
        // alias "x@y.com" should win over an account whose email is "x@y.com"
        "x@y.com": { email: "alias-as-email@z.com", refresh_token: "1" },
        other: { email: "x@y.com", refresh_token: "2" },
      },
    };
    expect(resolveAccount(data, "x@y.com").alias).toBe("x@y.com");
  });

  it("throws an actionable error listing accounts for an unknown account", () => {
    expect(() => resolveAccount(multi, "nope")).toThrowError(/Unknown account "nope"/);
    expect(() => resolveAccount(multi, "nope")).toThrowError(/work \(me@company\.com\)/);
  });

  it("throws when no accounts are configured", () => {
    expect(() => resolveAccount({ accounts: {} })).toThrowError(/No Gmail accounts are configured/);
  });
});

describe("formatAccountList", () => {
  it("formats aliases, emails, and the default marker", () => {
    expect(formatAccountList(multi.accounts)).toBe(
      "work (me@company.com) [default], personal (me@gmail.com)",
    );
  });

  it("handles the empty case", () => {
    expect(formatAccountList({})).toBe("(none configured)");
  });
});
