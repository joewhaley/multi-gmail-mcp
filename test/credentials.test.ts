import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthCredentials, credentialsSearchPaths } from "../src/accounts.js";

const ENV_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_OAUTH_CREDENTIALS",
  "MULTI_GMAIL_MCP_HOME",
] as const;

let saved: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Point the config dir at an isolated temp home so auto-discovery is deterministic.
  home = mkdtempSync(join(tmpdir(), "mgm-creds-"));
  process.env.MULTI_GMAIL_MCP_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getOAuthCredentials", () => {
  it("prefers GOOGLE_CLIENT_ID/SECRET env vars", () => {
    process.env.GOOGLE_CLIENT_ID = "env-id";
    process.env.GOOGLE_CLIENT_SECRET = "env-secret";
    expect(getOAuthCredentials()).toEqual({ clientId: "env-id", clientSecret: "env-secret" });
  });

  it("reads a credentials.json pointed to by GOOGLE_OAUTH_CREDENTIALS", () => {
    const path = join(home, "explicit.json");
    writeFileSync(path, JSON.stringify({ installed: { client_id: "file-id", client_secret: "file-secret" } }));
    process.env.GOOGLE_OAUTH_CREDENTIALS = path;
    expect(getOAuthCredentials()).toEqual({ clientId: "file-id", clientSecret: "file-secret" });
  });

  it("auto-discovers credentials.json in the config dir (installed)", () => {
    writeFileSync(
      join(home, "credentials.json"),
      JSON.stringify({ installed: { client_id: "auto-id", client_secret: "auto-secret" } }),
    );
    expect(getOAuthCredentials()).toEqual({ clientId: "auto-id", clientSecret: "auto-secret" });
  });

  it("supports the web client shape and a flat shape", () => {
    writeFileSync(
      join(home, "credentials.json"),
      JSON.stringify({ web: { client_id: "web-id", client_secret: "web-secret" } }),
    );
    expect(getOAuthCredentials()).toEqual({ clientId: "web-id", clientSecret: "web-secret" });
  });

  it("env vars take precedence over an auto-discovered file", () => {
    writeFileSync(
      join(home, "credentials.json"),
      JSON.stringify({ installed: { client_id: "auto-id", client_secret: "auto-secret" } }),
    );
    process.env.GOOGLE_CLIENT_ID = "env-id";
    process.env.GOOGLE_CLIENT_SECRET = "env-secret";
    expect(getOAuthCredentials().clientId).toBe("env-id");
  });

  it("includes the config dir in the search paths", () => {
    expect(credentialsSearchPaths()[0]).toBe(join(home, "credentials.json"));
  });

  it("throws an actionable error listing all options when nothing is configured", () => {
    expect(() => getOAuthCredentials()).toThrowError(/GOOGLE_CLIENT_ID/);
    expect(() => getOAuthCredentials()).toThrowError(/credentials\.json/);
  });

  it("rejects a malformed credentials file", () => {
    const path = join(home, "bad.json");
    writeFileSync(path, "{ not json ");
    process.env.GOOGLE_OAUTH_CREDENTIALS = path;
    expect(() => getOAuthCredentials()).toThrowError(/not valid JSON/);
  });
});
