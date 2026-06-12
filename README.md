# multi-gmail-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives an LLM read/label/draft access to **multiple Gmail accounts** from a single server.

The tool interface deliberately **mirrors the standard Gmail MCP connector** — same tool names, parameters, and semantics — with one addition: **every tool accepts an optional `account` parameter** selecting which mailbox to operate on (by alias or email). A `list_accounts` tool is added so the model can discover what's configured.

This server **creates drafts only — it never sends email.**

---

## Tools

| Tool | Purpose |
| --- | --- |
| `search_threads` | Search threads with full Gmail query syntax; returns per-message metadata (no bodies). |
| `get_thread` | Fetch a thread; `FULL_CONTENT` decodes the plain-text body and lists attachments. |
| `create_draft` | Build an RFC 2822 draft (text/html/attachments/replies). Never sends. |
| `list_drafts` | List drafts with subject/to/snippet. |
| `list_labels` | List user-defined labels (id, name, colors). |
| `create_label` | Create a label (supports `/` nesting and palette colors). |
| `update_label` | Rename / recolor a label. |
| `delete_label` | Delete a user label (refuses system labels). |
| `label_message` / `unlabel_message` | Add/remove labels on a message. |
| `label_thread` / `unlabel_thread` | Add/remove labels on a whole thread. |
| `list_accounts` | List configured accounts with email, default flag, and auth status. |

Every tool above (including `list_accounts`) accepts an optional **`account`** parameter.

### The `account` parameter

- A value can be an **alias** (`"work"`, `"personal"`) or the account's **email address**. Matching is case-insensitive.
- If **omitted**, the configured **default** account is used.
- If there is **no default and more than one** account, the call fails with an error listing the available accounts.
- An **unknown** account fails with an error listing valid accounts.

---

## Prerequisites

- **Node.js 18+**
- A **Google Cloud project** with the **Gmail API** enabled and an **OAuth Desktop-app** credential (see below).

---

## 1. Google Cloud setup (one-time)

1. **Create / pick a project** at <https://console.cloud.google.com/>.
2. **Enable the Gmail API:** *APIs & Services → Library → "Gmail API" → Enable*.
3. **Configure the OAuth consent screen:** *APIs & Services → OAuth consent screen*.
   - User type **External** (or **Internal** if you're in a Google Workspace org).
   - Fill in app name + support email.
   - **Scopes:** you can leave the scope list empty here; the server requests
     `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/gmail.labels` at auth time.
   - **Test users:** while the app is in *Testing*, add every Gmail address you intend to connect as a test user. (Test-mode refresh tokens expire after 7 days — publish the app to *Production* to get long-lived tokens.)
4. **Create credentials:** *APIs & Services → Credentials → Create Credentials → OAuth client ID*.
   - Application type: **Desktop app**.
   - Download the JSON (it looks like `{ "installed": { "client_id": ..., "client_secret": ... } }`).

> Desktop-app clients are allowed to use a `http://localhost:<port>` loopback redirect with a dynamic port, which is exactly what the `auth` flow uses — no redirect URIs to register.

---

## 2. Install

From npm (when published):

```bash
npm install -g multi-gmail-mcp     # or just use `npx multi-gmail-mcp ...`
```

From source:

```bash
git clone <this-repo> && cd multi-gmail-mcp
npm install        # also builds via the `prepare` script
npm run build      # (if needed) compile TypeScript to dist/
```

---

## 3. Provide your OAuth client credentials

The server resolves your OAuth **app** credentials from the first of these that is present:

```bash
# Option A — environment variables
export GOOGLE_CLIENT_ID="xxxxxxxx.apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="xxxxxxxx"

# Option B — point at the downloaded credentials.json
export GOOGLE_OAUTH_CREDENTIALS="/absolute/path/to/credentials.json"

# Option C — no env var needed: just drop the downloaded credentials.json into
#            ~/.multi-gmail-mcp/credentials.json  (or the current directory)
cp ~/Downloads/client_secret_*.json ~/.multi-gmail-mcp/credentials.json
```

Resolution order is A → B → C. The `credentials.json` is the file you downloaded
from Google Cloud Console; both the Desktop-app shape (`{ "installed": {...} }`)
and the web shape (`{ "web": {...} }`) are accepted.

These are only the **app** credentials. Per-account refresh tokens are obtained in the next step.

---

## 4. Add Gmail accounts

Run the interactive auth flow once per account. It opens a browser, runs Google
consent against a localhost loopback redirect, and stores the refresh token.

```bash
# alias the account however you like
npx multi-gmail-mcp auth work --default
npx multi-gmail-mcp auth personal
```

- `--default` marks the account as the default used when `account` is omitted. (The first account added becomes the default automatically.)
- Re-running `auth <alias>` re-authorizes (e.g. after a revoked token) and keeps the same alias.

### Token storage

Tokens are written to **`~/.multi-gmail-mcp/accounts.json`** with permissions **`0600`**:

```json
{
  "accounts": {
    "work":     { "email": "me@company.com", "refresh_token": "1//...", "default": true },
    "personal": { "email": "me@gmail.com",   "refresh_token": "1//..." }
  }
}
```

Access tokens are refreshed automatically and cached in memory per account. If a
refresh token is revoked or expires, tool calls for that account return an
actionable error telling you to re-run `auth <alias>`. (You can override the
config directory with `MULTI_GMAIL_MCP_HOME`.)

Verify everything is connected:

```bash
# from an MCP client, call list_accounts — or check status quickly:
npx multi-gmail-mcp   # starts the server; use your MCP client to call list_accounts
```

---

## 5. Configure your MCP client

### Claude Desktop / Claude Code (`mcpServers` JSON)

Add to your MCP client config (e.g. `claude_desktop_config.json`, or a project `.mcp.json`):

```json
{
  "mcpServers": {
    "multi-gmail": {
      "command": "npx",
      "args": ["-y", "multi-gmail-mcp"],
      "env": {
        "GOOGLE_CLIENT_ID": "xxxxxxxx.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "xxxxxxxx"
      }
    }
  }
}
```

Running from a local checkout instead:

```json
{
  "mcpServers": {
    "multi-gmail": {
      "command": "node",
      "args": ["/absolute/path/to/multi-gmail-mcp/dist/index.js"],
      "env": { "GOOGLE_OAUTH_CREDENTIALS": "/absolute/path/to/credentials.json" }
    }
  }
}
```

### Claude Code CLI

```bash
claude mcp add multi-gmail \
  --env GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com \
  --env GOOGLE_CLIENT_SECRET=xxxx \
  -- npx -y multi-gmail-mcp
```

> The `auth` step must be run separately in a terminal (it opens a browser); the MCP host only runs the server.

---

## Example invocations

Once connected, natural-language requests map to tool calls like:

- **Search the work inbox:** `search_threads` with
  `{ "query": "in:inbox is:unread newer_than:7d", "account": "work" }`
- **Read a thread from personal:** `get_thread` with
  `{ "threadId": "18c...", "messageFormat": "FULL_CONTENT", "account": "personal" }`
- **Draft a reply from personal:** `create_draft` with
  `{ "to": ["friend@example.com"], "body": "Sounds good!", "replyToMessageId": "18c...", "account": "personal" }`
- **Label a thread in work:** `label_thread` with
  `{ "threadId": "18c...", "labelIds": ["Label_42"], "account": "work" }`
- **List accounts:** `list_accounts` with `{}`.

Omitting `account` uses the default account.

---

## Gmail query syntax (search_threads)

Supports the full Gmail operator set, e.g. `from:`, `to:`, `cc:`, `subject:`,
`label:<id>`, `in:(inbox|sent|trash|spam|anywhere)`, `is:(unread|starred|important)`,
`has:attachment`, `filename:`, `after:/before:YYYY/MM/DD`, `newer_than:7d`,
`older_than:1y`, `larger:/smaller:`, grouping with `()`/`{}`, `OR`, and `-` to
exclude. Use **label IDs** (from `list_labels`), not display names, with `label:`.
Drafts are excluded by default; set `includeTrash: true` to also search Trash/Spam.

---

## Development

```bash
npm run build        # compile TypeScript -> dist/
npm test             # vitest: alias resolution, MIME building, query passthrough
node scripts/smoke.mjs   # connect over stdio; verify 13 tools + optional `account`
```

Source layout:

| File | Responsibility |
| --- | --- |
| `src/index.ts` | MCP server, tool registry, CLI dispatcher (`auth` vs. server). |
| `src/accounts.ts` | Config + token store, OAuth client construction, alias resolution. |
| `src/gmail.ts` | Gmail REST wrappers, query building, body decoding, retry/error mapping. |
| `src/auth-cli.ts` | `auth <alias>` loopback OAuth flow. |
| `src/mime.ts` | RFC 2822 MIME construction for drafts. |

---

## Behavior notes & limits

- **Drafts only.** There is no send capability by design.
- **Bodies** over ~50KB are truncated (flagged); raw attachment bytes are never returned by `get_thread` — only metadata + `attachmentId`.
- **Attachments** in `create_draft` must total ≤ 25MB; link large files from Drive instead.
- **Rate limits / 5xx** are retried up to 3 times with exponential backoff; persistent failures return a clear error.
- **Auth errors** (`401` / `invalid_grant`) tell you exactly which account to re-auth.
- **System labels** can be used directly by ID (`INBOX`, `TRASH`, `SPAM`, `STARRED`, `UNREAD`, `IMPORTANT`, `DRAFT`, `SENT`); they cannot be deleted or modified.

## License

MIT
