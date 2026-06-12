/**
 * Account configuration, OAuth client construction, and token storage.
 *
 * Accounts live in ~/.multi-gmail-mcp/accounts.json (mode 0600):
 *
 *   {
 *     "accounts": {
 *       "work":     { "email": "me@company.com", "refresh_token": "...", "default": true },
 *       "personal": { "email": "me@gmail.com",   "refresh_token": "..." }
 *     }
 *   }
 *
 * OAuth client id/secret are NOT stored here — they come from the environment
 * (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET, or a credentials.json pointed to by
 * GOOGLE_OAUTH_CREDENTIALS) so the same desktop credential can be reused.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

/** Gmail scopes requested for every account. */
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
];

/** A single configured account. */
export interface AccountConfig {
  email: string;
  refresh_token: string;
  default?: boolean;
}

/** Top-level shape of accounts.json. */
export interface AccountsFile {
  accounts: Record<string, AccountConfig>;
}

/** A resolved account: its alias plus stored config. */
export interface ResolvedAccount {
  alias: string;
  config: AccountConfig;
}

/**
 * Thrown for configuration / account-selection problems. The message is already
 * human readable and safe to surface directly to the user (no stack traces).
 */
export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountError";
  }
}

export function configDir(): string {
  return process.env.MULTI_GMAIL_MCP_HOME ?? join(homedir(), ".multi-gmail-mcp");
}

export function accountsPath(): string {
  return join(configDir(), "accounts.json");
}

/** Load accounts.json, returning an empty structure if it does not exist. */
export function loadAccounts(): AccountsFile {
  const path = accountsPath();
  if (!existsSync(path)) return { accounts: {} };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new AccountError(`Unable to read ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AccountError(`${path} is not valid JSON. Fix or delete it and re-run auth.`);
  }
  const accounts = (parsed as AccountsFile | null)?.accounts;
  if (!accounts || typeof accounts !== "object") return { accounts: {} };
  return { accounts };
}

/** Persist accounts.json with restrictive (0600) permissions. */
export function saveAccounts(data: AccountsFile): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = accountsPath();
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  // writeFileSync's mode is only applied on creation; enforce it explicitly so
  // an existing file with looser permissions is tightened.
  chmodSync(path, 0o600);
}

/**
 * Insert or update an account, persisting to disk. The first account added (or
 * any account explicitly marked) becomes the default. Returns the saved entry.
 */
export function upsertAccount(
  alias: string,
  email: string,
  refresh_token: string,
  makeDefault?: boolean,
): AccountConfig {
  const data = loadAccounts();
  const existing = data.accounts[alias];
  const hasDefault = Object.values(data.accounts).some((a) => a.default);
  const isDefault = makeDefault || existing?.default || !hasDefault;

  if (isDefault) {
    for (const a of Object.values(data.accounts)) delete a.default;
  }
  const config: AccountConfig = { email, refresh_token };
  if (isDefault) config.default = true;
  data.accounts[alias] = config;
  saveAccounts(data);
  return config;
}

/** Human-readable list of configured accounts, e.g. "work (a@b.com), personal (c@d.com)". */
export function formatAccountList(accounts: Record<string, AccountConfig>): string {
  const entries = Object.entries(accounts);
  if (entries.length === 0) return "(none configured)";
  return entries
    .map(([alias, cfg]) => `${alias} (${cfg.email})${cfg.default ? " [default]" : ""}`)
    .join(", ");
}

/**
 * Resolve an optional `account` parameter to a concrete account.
 *
 * - If provided, match by alias (case-insensitive) then by email address.
 * - If omitted, use the configured default; if no default and exactly one
 *   account exists, use it; otherwise raise an actionable error.
 *
 * Errors always list the valid accounts.
 */
export function resolveAccount(data: AccountsFile, account?: string): ResolvedAccount {
  const entries = Object.entries(data.accounts);
  if (entries.length === 0) {
    throw new AccountError(
      "No Gmail accounts are configured. Add one with: npx multi-gmail-mcp auth <alias>",
    );
  }

  if (account && account.trim()) {
    const needle = account.trim().toLowerCase();
    const byAlias = entries.find(([alias]) => alias.toLowerCase() === needle);
    if (byAlias) return { alias: byAlias[0], config: byAlias[1] };
    const byEmail = entries.find(([, cfg]) => cfg.email.toLowerCase() === needle);
    if (byEmail) return { alias: byEmail[0], config: byEmail[1] };
    throw new AccountError(
      `Unknown account "${account}". Available accounts: ${formatAccountList(data.accounts)}.`,
    );
  }

  const def = entries.find(([, cfg]) => cfg.default);
  if (def) return { alias: def[0], config: def[1] };
  if (entries.length === 1) {
    const [alias, config] = entries[0]!;
    return { alias, config };
  }

  throw new AccountError(
    `No default account is configured and multiple accounts exist. ` +
      `Pass the "account" parameter (alias or email). Available accounts: ${formatAccountList(
        data.accounts,
      )}.`,
  );
}

/**
 * OAuth client credentials. Sourced, in priority order, from:
 *   1. GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET env vars
 *   2. a Google-issued credentials.json at the GOOGLE_OAUTH_CREDENTIALS path
 *   3. an auto-discovered credentials.json in a well-known location
 */
export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Locations searched (in order) for a credentials.json when neither the
 * client-id/secret env vars nor GOOGLE_OAUTH_CREDENTIALS are set:
 *   - <config dir>/credentials.json  (e.g. ~/.multi-gmail-mcp/credentials.json)
 *   - ./credentials.json             (current working directory)
 */
export function credentialsSearchPaths(): string[] {
  return [join(configDir(), "credentials.json"), join(process.cwd(), "credentials.json")];
}

/** Parse a Google OAuth credentials.json and extract client_id/client_secret. */
function parseCredentialsFile(path: string): OAuthCredentials {
  let json: any;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new AccountError(`Credentials file is not valid JSON: ${path}`);
  }
  // Google downloads use { installed: {...} } for Desktop apps, { web: {...} } for web apps.
  // Also accept a flat { client_id, client_secret } object.
  const node = json.installed ?? json.web ?? json;
  if (node?.client_id && node?.client_secret) {
    return { clientId: node.client_id, clientSecret: node.client_secret };
  }
  throw new AccountError(
    `${path} does not contain client_id/client_secret under "installed" or "web".`,
  );
}

export function getOAuthCredentials(): OAuthCredentials {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_OAUTH_CREDENTIALS } = process.env;

  // 1. Explicit client id/secret env vars.
  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    return { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET };
  }

  // 2. Explicit credentials.json path.
  if (GOOGLE_OAUTH_CREDENTIALS) {
    if (!existsSync(GOOGLE_OAUTH_CREDENTIALS)) {
      throw new AccountError(
        `GOOGLE_OAUTH_CREDENTIALS points to a file that does not exist: ${GOOGLE_OAUTH_CREDENTIALS}`,
      );
    }
    return parseCredentialsFile(GOOGLE_OAUTH_CREDENTIALS);
  }

  // 3. Auto-discover a credentials.json in a well-known location.
  for (const candidate of credentialsSearchPaths()) {
    if (existsSync(candidate)) return parseCredentialsFile(candidate);
  }

  throw new AccountError(
    "Google OAuth credentials are not configured. Provide them in any of these ways:\n" +
      "  • set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or\n" +
      "  • set GOOGLE_OAUTH_CREDENTIALS to the path of a Desktop-app credentials.json, or\n" +
      `  • place a credentials.json at one of: ${credentialsSearchPaths().join(" or ")}.\n` +
      "See the README for how to create these in Google Cloud Console.",
  );
}

/** Construct a fresh OAuth2 client (optionally with a redirect URI for the auth flow). */
export function createOAuth2Client(redirectUri?: string): OAuth2Client {
  const { clientId, clientSecret } = getOAuthCredentials();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// In-memory cache of authenticated clients, keyed by alias. The OAuth2Client
// caches its own access token and refreshes it automatically on expiry, so
// reusing the client gives us in-memory access-token caching for free.
const clientCache = new Map<string, OAuth2Client>();

/** Get an authenticated OAuth2 client for an account, primed with its refresh token. */
export function getAuthClient(alias: string, config: AccountConfig): OAuth2Client {
  const cached = clientCache.get(alias);
  if (cached) return cached;
  const client = createOAuth2Client();
  client.setCredentials({ refresh_token: config.refresh_token });
  clientCache.set(alias, client);
  return client;
}

/** Clear the cached client for an account (used after re-auth). */
export function invalidateAuthClient(alias: string): void {
  clientCache.delete(alias);
}

export type AuthStatus = "valid" | "needs_reauth";

/**
 * Determine whether an account's refresh token can still mint an access token.
 * Used by list_accounts. Performs one lightweight network call.
 */
export async function checkAuthStatus(client: OAuth2Client): Promise<AuthStatus> {
  try {
    const res = await client.getAccessToken();
    return res?.token ? "valid" : "needs_reauth";
  } catch {
    return "needs_reauth";
  }
}
