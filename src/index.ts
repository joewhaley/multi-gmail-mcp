#!/usr/bin/env node
/**
 * multi-gmail-mcp — MCP server exposing Gmail across multiple accounts.
 *
 * The tool interface mirrors the standard Gmail MCP connector (same tool names,
 * parameters, and semantics) and adds an optional `account` selector to every
 * tool, plus a `list_accounts` tool.
 *
 * Entry behavior:
 *   - `multi-gmail-mcp auth <alias>` runs the interactive OAuth flow.
 *   - With no recognized subcommand, it runs the MCP server over stdio.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { OAuth2Client } from "google-auth-library";
import {
  loadAccounts,
  resolveAccount,
  getAuthClient,
  checkAuthStatus,
  AccountError,
} from "./accounts.js";
import {
  searchThreads,
  getThread,
  createDraft,
  listDrafts,
  deleteDraft,
  listLabels,
  createLabel,
  updateLabel,
  deleteLabel,
  modifyMessageLabels,
  modifyThreadLabels,
  describeGmailError,
} from "./gmail.js";

// ---------------------------------------------------------------------------
// Shared response helpers + account-aware execution wrapper
// ---------------------------------------------------------------------------

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Resolve the requested account, build its auth client, run `fn`, and convert
 * any failure into a clean MCP error (never a raw stack trace).
 */
async function withAccount(
  account: string | undefined,
  fn: (auth: OAuth2Client, alias: string) => Promise<unknown>,
): Promise<ToolResult> {
  let aliasForError = account ?? "(default)";
  try {
    const data = loadAccounts();
    const resolved = resolveAccount(data, account);
    aliasForError = resolved.alias;
    const auth = getAuthClient(resolved.alias, resolved.config);
    return ok(await fn(auth, resolved.alias));
  } catch (err) {
    if (err instanceof AccountError) return fail(err.message);
    return fail(describeGmailError(err, aliasForError).message);
  }
}

// Reusable optional `account` field, attached to every tool.
const accountField = {
  account: z
    .string()
    .optional()
    .describe(
      "Which configured Gmail account to operate on: an alias (e.g. \"work\", \"personal\") or " +
        "the account's email address. Matching is case-insensitive. If omitted, the configured " +
        "default account is used; if no default is set and multiple accounts exist, the call fails " +
        "and lists the available accounts. Call list_accounts to see configured accounts.",
    ),
};

const pageSizeField = (max: number, def: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`Maximum number of items to return. Defaults to ${def}, maximum ${max}.`);

const pageTokenField = z
  .string()
  .optional()
  .describe("Opaque pagination token from a previous response's nextPageToken. Omit for the first page.");

// ---------------------------------------------------------------------------
// Server + tool registration
// ---------------------------------------------------------------------------

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "multi-gmail-mcp", version: "0.1.0" },
    {
      instructions:
        "Gmail access across multiple accounts. Every tool accepts an optional `account` parameter " +
        "(alias or email) selecting which mailbox to use; omit it to use the default account. " +
        "Start with list_accounts to discover configured accounts. This server creates drafts only " +
        "and never sends email.",
    },
  );

  // --- 1. search_threads ---------------------------------------------------
  server.registerTool(
    "search_threads",
    {
      title: "Search Gmail threads",
      description:
        "Search email threads in the selected account and return thread IDs with per-message " +
        "metadata (snippet, subject, from, to, cc, date). Full message BODIES are NOT returned — " +
        "use get_thread with a threadId to read bodies and list attachments.\n\n" +
        "The `query` uses full Gmail search syntax. Operators include:\n" +
        "  • Sender/recipient: from:, to:, cc:, bcc:, deliveredto:, list:\n" +
        "  • Subject/content: subject:, \"exact phrase\", +exactword, has:attachment, filename:, AROUND\n" +
        "  • Time: after:YYYY/MM/DD, before:YYYY/MM/DD, older:, newer:, older_than:1y, newer_than:7d\n" +
        "  • Labels/folders: label:<labelId> (use the label ID, not its name — see list_labels), " +
        "category:(primary|social|promotions|updates|forums), in:(inbox|sent|trash|spam|anywhere)\n" +
        "  • Status/size: is:(unread|read|starred|important|muted), larger:10M, smaller:1M\n" +
        "  • Logic: AND (implicit), OR or {a b}, - to exclude, ( ) to group.\n" +
        "Examples: \"from:amy@x.com newer_than:7d\", \"subject:(invoice OR receipt) has:attachment\", " +
        "\"is:unread -in:promotions\".\n\n" +
        "Drafts are excluded by default. Trash & spam are excluded unless includeTrash is true. Note: " +
        "Gmail matches at the message level, so a thread can appear if ANY of its messages match a " +
        "negated term.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Gmail search query (see the operator list in this tool's description). Natural-language " +
              "requests must be converted to Gmail syntax first. If omitted, returns recent threads " +
              "(excluding drafts, trash, and spam).",
          ),
        pageSize: pageSizeField(50, 20),
        pageToken: pageTokenField,
        includeTrash: z
          .boolean()
          .optional()
          .describe("Include threads in Trash and Spam (widens the search to in:anywhere). Defaults to false."),
        ...accountField,
      },
    },
    async ({ query, pageSize, pageToken, includeTrash, account }) =>
      withAccount(account, (auth, alias) =>
        searchThreads(auth, alias, { query, pageSize, pageToken, includeTrash }),
      ),
  );

  // --- 2. get_thread -------------------------------------------------------
  server.registerTool(
    "get_thread",
    {
      title: "Get a Gmail thread",
      description:
        "Fetch a single thread and its messages from the selected account.\n\n" +
        "messageFormat:\n" +
        "  • FULL_CONTENT (default): includes key headers, the decoded plain-text body (HTML is " +
        "converted to text when no plain-text part exists), and attachment metadata (filename, " +
        "mimeType, size, attachmentId). Raw attachment bytes are never returned. Bodies larger than " +
        "~50KB are truncated with a flag.\n" +
        "  • MINIMAL: returns snippets and key headers only (Subject, From, To, Cc, Date) — no body " +
        "or attachments.",
      inputSchema: {
        threadId: z.string().min(1).describe("The thread ID (e.g. from search_threads results)."),
        messageFormat: z
          .enum(["MINIMAL", "FULL_CONTENT"])
          .optional()
          .describe("MINIMAL for snippets+headers; FULL_CONTENT (default) for bodies + attachment metadata."),
        ...accountField,
      },
    },
    async ({ threadId, messageFormat, account }) =>
      withAccount(account, (auth, alias) => getThread(auth, alias, { threadId, messageFormat })),
  );

  // --- 3. create_draft -----------------------------------------------------
  server.registerTool(
    "create_draft",
    {
      title: "Create a Gmail draft",
      description:
        "Create a draft email in the selected account and return its draft ID. This server creates " +
        "drafts ONLY — it never sends mail.\n\n" +
        "Recipients (to/cc/bcc) must be plain email addresses (\"user@example.com\"); the " +
        "\"Name <user@example.com>\" form is not accepted. Provide `body` (plain text) and/or " +
        "`htmlBody` (rich text); when both are given, a multipart/alternative message is built.\n\n" +
        "Set `replyToMessageId` to the message ID being replied to: the draft inherits the thread, " +
        "sets In-Reply-To/References headers, and prefixes the subject with \"Re: \" (unless you " +
        "supply your own subject).\n\n" +
        "Attachments: array of { filename, mimeType, content (base64), inline? }; combined size must " +
        "be ≤ 25MB. Set inline:true for images referenced from HTML via cid:<filename>.",
      inputSchema: {
        to: z
          .array(z.string())
          .min(1)
          .describe("Primary recipients as plain email addresses. At least one is required."),
        cc: z.array(z.string()).optional().describe("CC recipients (plain email addresses)."),
        bcc: z.array(z.string()).optional().describe("BCC recipients (plain email addresses)."),
        subject: z.string().optional().describe("Subject line. Defaults to empty (or inherited on replies)."),
        body: z.string().optional().describe("Plain-text body. Becomes the text/plain alternative when htmlBody is also set."),
        htmlBody: z.string().optional().describe("HTML body (rich-text version of the email)."),
        replyToMessageId: z
          .string()
          .optional()
          .describe("Message ID to reply to; threads the draft and sets reply headers."),
        attachments: z
          .array(
            z.object({
              filename: z.string().optional().describe("File name shown to recipients, e.g. \"invoice.pdf\"."),
              mimeType: z
                .string()
                .optional()
                .describe("IANA MIME type, e.g. \"application/pdf\". Defaults to application/octet-stream."),
              content: z.string().describe("Base64-encoded file content."),
              inline: z
                .boolean()
                .optional()
                .describe("If true, embed inline (referenceable from HTML as cid:<filename>)."),
            }),
          )
          .optional()
          .describe("Attachments to include; combined size ≤ 25MB."),
        ...accountField,
      },
    },
    async ({ to, cc, bcc, subject, body, htmlBody, replyToMessageId, attachments, account }) =>
      withAccount(account, (auth, alias) =>
        createDraft(auth, alias, {
          to,
          cc,
          bcc,
          subject,
          body,
          htmlBody,
          replyToMessageId,
          attachments,
        }),
      ),
  );

  // --- 4. list_drafts ------------------------------------------------------
  server.registerTool(
    "list_drafts",
    {
      title: "List Gmail drafts",
      description:
        "List draft emails in the selected account, returning each draft's draftId, messageId, " +
        "subject, to, and snippet. Use create_draft to create drafts; use get_thread for full content.",
      inputSchema: {
        pageSize: pageSizeField(50, 20),
        pageToken: pageTokenField,
        ...accountField,
      },
    },
    async ({ pageSize, pageToken, account }) =>
      withAccount(account, (auth, alias) => listDrafts(auth, alias, { pageSize, pageToken })),
  );

  // --- 5. delete_draft -----------------------------------------------------
  server.registerTool(
    "delete_draft",
    {
      title: "Delete a Gmail draft",
      description:
        "Permanently delete a draft email in the selected account, identified by its draftId (e.g. " +
        "from list_drafts or a create_draft response). This PERMANENTLY removes the draft — it is NOT " +
        "moved to Trash and cannot be recovered, so confirm the draftId before deleting. Only affects " +
        "drafts; it never deletes sent or received messages. An unknown draftId returns a not-found error.",
      inputSchema: {
        draftId: z
          .string()
          .min(1)
          .describe("The ID of the draft to delete (the draftId from list_drafts or create_draft)."),
        ...accountField,
      },
    },
    async ({ draftId, account }) =>
      withAccount(account, (auth, alias) => deleteDraft(auth, alias, { draftId })),
  );

  // --- 6. list_labels ------------------------------------------------------
  server.registerTool(
    "list_labels",
    {
      title: "List Gmail labels",
      description:
        "List USER-DEFINED labels in the selected account (id, name, type, and colors). System labels " +
        "are not listed but can be used directly by their well-known IDs: INBOX, TRASH, SPAM, STARRED, " +
        "UNREAD, IMPORTANT, DRAFT, SENT. Use a label's `id` (not its display name) with the label/unlabel " +
        "tools and with the search query operator label:<id>.",
      inputSchema: {
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Maximum number of labels to return. If omitted, all user labels are returned (paginated client-side)."),
        pageToken: pageTokenField,
        ...accountField,
      },
    },
    async ({ pageSize, pageToken, account }) =>
      withAccount(account, (auth, alias) => listLabels(auth, alias, { pageSize, pageToken })),
  );

  // --- 7. create_label -----------------------------------------------------
  server.registerTool(
    "create_label",
    {
      title: "Create a Gmail label",
      description:
        "Create a new user label in the selected account and return its ID. Supports nesting with " +
        "forward slashes (e.g. \"Projects/Alpha\"); missing parent labels are created automatically.\n\n" +
        "Optional textColor and backgroundColor must BOTH be provided together and must be values from " +
        "Gmail's fixed palette of hex colors (e.g. #ffffff, #000000, #16a766, #4a86e8, #fb4c2f, ...). " +
        "Invalid colors are rejected with a clear error.",
      inputSchema: {
        name: z.string().min(1).describe("Label display name. Use \"/\" for nested sub-labels."),
        textColor: z.string().optional().describe("Text color hex from Gmail's palette. Requires backgroundColor too."),
        backgroundColor: z.string().optional().describe("Background color hex from Gmail's palette. Requires textColor too."),
        ...accountField,
      },
    },
    async ({ name, textColor, backgroundColor, account }) =>
      withAccount(account, (auth, alias) => createLabel(auth, alias, { name, textColor, backgroundColor })),
  );

  // --- 8. update_label -----------------------------------------------------
  server.registerTool(
    "update_label",
    {
      title: "Update a Gmail label",
      description:
        "Rename and/or recolor an existing user label (identified by its label ID, e.g. from " +
        "list_labels). Provide any of name, textColor, backgroundColor. Colors must come in pairs and " +
        "use Gmail's allowed palette. System labels cannot be modified.",
      inputSchema: {
        labelId: z.string().min(1).describe("The ID of the label to modify (see list_labels)."),
        name: z.string().optional().describe("New display name."),
        textColor: z.string().optional().describe("New text color hex (requires backgroundColor)."),
        backgroundColor: z.string().optional().describe("New background color hex (requires textColor)."),
        ...accountField,
      },
    },
    async ({ labelId, name, textColor, backgroundColor, account }) =>
      withAccount(account, (auth, alias) =>
        updateLabel(auth, alias, { labelId, name, textColor, backgroundColor }),
      ),
  );

  // --- 9. delete_label -----------------------------------------------------
  server.registerTool(
    "delete_label",
    {
      title: "Delete a Gmail label",
      description:
        "Permanently delete a user label by its ID. The label is removed from all messages/threads it " +
        "was applied to. System labels (INBOX, SENT, TRASH, etc.) cannot be deleted and the request is " +
        "refused.",
      inputSchema: {
        labelId: z.string().min(1).describe("The ID of the user label to delete (see list_labels)."),
        ...accountField,
      },
    },
    async ({ labelId, account }) =>
      withAccount(account, (auth, alias) => deleteLabel(auth, alias, { labelId })),
  );

  // --- 10. label_message ---------------------------------------------------
  server.registerTool(
    "label_message",
    {
      title: "Add labels to a message",
      description:
        "Add one or more labels to a single message. labelIds must be label IDs (not display names): " +
        "either a system label ID (INBOX, UNREAD, STARRED, IMPORTANT, SPAM, TRASH, ...) or a user " +
        "label ID from list_labels. Find message IDs via get_thread.",
      inputSchema: {
        messageId: z.string().min(1).describe("The message ID to label."),
        labelIds: z.array(z.string()).min(1).describe("Label IDs to add (system or user label IDs)."),
        ...accountField,
      },
    },
    async ({ messageId, labelIds, account }) =>
      withAccount(account, (auth, alias) =>
        modifyMessageLabels(auth, alias, { messageId, labelIds, add: true }),
      ),
  );

  // --- 11. unlabel_message -------------------------------------------------
  server.registerTool(
    "unlabel_message",
    {
      title: "Remove labels from a message",
      description:
        "Remove one or more labels from a single message. labelIds must be label IDs (not display " +
        "names) — system label IDs (e.g. UNREAD to mark read, INBOX to archive) or user label IDs " +
        "from list_labels. Find message IDs via get_thread.",
      inputSchema: {
        messageId: z.string().min(1).describe("The message ID to unlabel."),
        labelIds: z.array(z.string()).min(1).describe("Label IDs to remove (system or user label IDs)."),
        ...accountField,
      },
    },
    async ({ messageId, labelIds, account }) =>
      withAccount(account, (auth, alias) =>
        modifyMessageLabels(auth, alias, { messageId, labelIds, add: false }),
      ),
  );

  // --- 12. label_thread ----------------------------------------------------
  server.registerTool(
    "label_thread",
    {
      title: "Add labels to a thread",
      description:
        "Add one or more labels to an entire thread (affects all current and future messages in it). " +
        "labelIds must be label IDs (not display names): system label IDs or user label IDs from " +
        "list_labels. Find thread IDs via search_threads.",
      inputSchema: {
        threadId: z.string().min(1).describe("The thread ID to label."),
        labelIds: z.array(z.string()).min(1).describe("Label IDs to add (system or user label IDs)."),
        ...accountField,
      },
    },
    async ({ threadId, labelIds, account }) =>
      withAccount(account, (auth, alias) =>
        modifyThreadLabels(auth, alias, { threadId, labelIds, add: true }),
      ),
  );

  // --- 13. unlabel_thread --------------------------------------------------
  server.registerTool(
    "unlabel_thread",
    {
      title: "Remove labels from a thread",
      description:
        "Remove one or more labels from an entire thread. labelIds must be label IDs (not display " +
        "names): system label IDs (e.g. INBOX to archive the whole thread) or user label IDs from " +
        "list_labels. Find thread IDs via search_threads.",
      inputSchema: {
        threadId: z.string().min(1).describe("The thread ID to unlabel."),
        labelIds: z.array(z.string()).min(1).describe("Label IDs to remove (system or user label IDs)."),
        ...accountField,
      },
    },
    async ({ threadId, labelIds, account }) =>
      withAccount(account, (auth, alias) =>
        modifyThreadLabels(auth, alias, { threadId, labelIds, add: false }),
      ),
  );

  // --- 14. list_accounts ---------------------------------------------------
  server.registerTool(
    "list_accounts",
    {
      title: "List configured Gmail accounts",
      description:
        "List the Gmail accounts configured for this server. For each account returns its alias, " +
        "email, whether it is the default, and its auth status: \"valid\" (token works) or " +
        "\"needs_reauth\" (re-run `npx multi-gmail-mcp auth <alias>`). Optionally pass `account` to " +
        "check a single account. Use the returned alias or email as the `account` parameter on other tools.",
      inputSchema: {
        account: z
          .string()
          .optional()
          .describe("Optional: limit the listing to a single account (alias or email)."),
      },
    },
    async ({ account }) => {
      try {
        const data = loadAccounts();
        let entries = Object.entries(data.accounts);
        if (account && account.trim()) {
          const resolved = resolveAccount(data, account); // throws with a clear message if unknown
          entries = entries.filter(([alias]) => alias === resolved.alias);
        }
        const accounts = await Promise.all(
          entries.map(async ([alias, cfg]) => {
            const client = getAuthClient(alias, cfg);
            const authStatus = await checkAuthStatus(client);
            return { alias, email: cfg.email, default: !!cfg.default, authStatus };
          }),
        );
        return ok({ accounts });
      } catch (err) {
        if (err instanceof AccountError) return fail(err.message);
        return fail((err as Error).message ?? "Failed to list accounts.");
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(
    [
      "multi-gmail-mcp — Gmail MCP server for multiple accounts",
      "",
      "Usage:",
      "  multi-gmail-mcp                 Start the MCP server over stdio (used by MCP hosts).",
      "  multi-gmail-mcp auth <alias>    Authorize a Gmail account and store its refresh token.",
      "  multi-gmail-mcp auth <alias> --default   Authorize and mark this account as the default.",
      "  multi-gmail-mcp --help          Show this help.",
      "",
      "Before authorizing, provide your OAuth client either via GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET,",
      "via GOOGLE_OAUTH_CREDENTIALS=/path/to/credentials.json, or by placing credentials.json in",
      "~/.multi-gmail-mcp/ or the current directory.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  if (command === "auth") {
    const { runAuthCli } = await import("./auth-cli.js");
    await runAuthCli(rest);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    printUsage();
    return;
  }

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so we don't corrupt the stdio JSON-RPC stream on stdout.
  console.error("multi-gmail-mcp server running on stdio.");
}

main().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
