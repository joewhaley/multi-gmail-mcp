#!/usr/bin/env node
/**
 * multi-gmail-mcp — MCP server exposing Gmail across multiple accounts.
 *
 * The tool interface mirrors the standard Gmail MCP connector (same tool names,
 * parameters, and semantics) and adds an optional `account` selector to every
 * tool, plus list_accounts, delete_draft, update_label and delete_label.
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
  getMessage,
  createDraft,
  listDrafts,
  getDraft,
  deleteDraft,
  listLabels,
  createLabel,
  updateLabel,
  deleteLabel,
  modifyMessageLabels,
  modifyThreadLabels,
  trash,
  untrash,
  markSpam,
  unmarkSpam,
  applySensitiveLabel,
  describeGmailError,
  type AccountCtx,
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
  fn: (auth: OAuth2Client, ctx: AccountCtx) => Promise<unknown>,
): Promise<ToolResult> {
  let aliasForError = account ?? "(default)";
  try {
    const data = loadAccounts();
    const resolved = resolveAccount(data, account);
    aliasForError = resolved.alias;
    const auth = getAuthClient(resolved.alias, resolved.config);
    return ok(await fn(auth, { alias: resolved.alias, email: resolved.config.email }));
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

const FORMAT_DOC =
  "  • PLAIN_TEXT (default): headers, snippet, labelIds, plain-text `body` (HTML is converted to " +
  "text with link URLs kept as [text](url) when there is no text part), and attachment metadata.\n" +
  "  • FULL_CONTENT: PLAIN_TEXT plus the original `htmlBody`.\n" +
  "  • MINIMAL: subject, snippet, addresses, date, labelIds — no body.\n" +
  "  • METADATA_ONLY: ids, addresses, date, labelIds, sizeEstimate — no subject/snippet/body.\n" +
  "Every message includes a `viewUrl` that opens it in Gmail on the web.";

const messageFormatEnum = (withRaw: boolean) =>
  z
    .enum(
      withRaw
        ? ["MESSAGE_FORMAT_UNSPECIFIED", "PLAIN_TEXT", "FULL_CONTENT", "MINIMAL", "METADATA_ONLY", "RAW"]
        : ["MESSAGE_FORMAT_UNSPECIFIED", "PLAIN_TEXT", "FULL_CONTENT", "MINIMAL", "METADATA_ONLY"],
    )
    .optional()
    .describe(
      "Output format. Defaults to PLAIN_TEXT. Use FULL_CONTENT only when the HTML body is needed." +
        (withRaw ? " RAW returns the raw RFC 2822 MIME source." : ""),
    );

const bodyWindowFields = {
  bodyOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Byte offset into the plain-text body (or the raw source for RAW) to start from. Bodies are " +
        "returned in ~50KB windows; when a response has bodyTruncated/rawTruncated, pass its " +
        "nextBodyOffset/nextRawOffset here to read the next window. Defaults to 0.",
    ),
  htmlBodyOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Byte offset into htmlBody (FULL_CONTENT only); pass nextHtmlBodyOffset to continue."),
};

const SEARCH_SYNTAX_DOC =
  "The `query` uses full Gmail search syntax. Operators include:\n" +
  "  • Sender/recipient: from:, to:, cc:, bcc:, deliveredto:, list:\n" +
  "  • Content: subject:, \"exact phrase\", +exactword, has:(attachment|drive|youtube|document), " +
  "filename:, rfc822msgid:, AROUND N\n" +
  "  • Time: after:/newer:YYYY/MM/DD (inclusive, from midnight), before:/older:YYYY/MM/DD " +
  "(exclusive), older_than:1y, newer_than:7d. For a single day D use after:D before:D+1.\n" +
  "  • Labels: label:<name> uses the label's display NAME from list_labels (quote names with " +
  "spaces: label:\"Board Prep\", or replace spaces and / with -); label IDs like Label_123 match " +
  "nothing. category:(primary|social|promotions|updates|forums|reservations|purchases), " +
  "in:(inbox|sent|archive|snoozed|trash|spam|anywhere), has:userlabels, has:nouserlabels\n" +
  "  • Status/size: is:(unread|read|starred|important|muted), size:, larger:10M, smaller:1M\n" +
  "  • Logic: AND (implicit), OR or {a b}, - to exclude, ( ) to group.\n" +
  "Quote hyphenated or dotted identifiers (\"INV-12345\") so - is not read as negation. Prefer " +
  "short keyword queries over long verbatim subjects.";

// ---------------------------------------------------------------------------
// Server + tool registration
// ---------------------------------------------------------------------------

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "multi-gmail-mcp", version: "0.2.0" },
    {
      instructions:
        "Gmail access across multiple accounts. Every tool accepts an optional `account` parameter " +
        "(alias or email) selecting which mailbox to use; omit it to use the default account. " +
        "Start with list_accounts to discover configured accounts. This server creates drafts only " +
        "and never sends email.",
    },
  );

  // --- search_threads -----------------------------------------------------
  server.registerTool(
    "search_threads",
    {
      title: "Search Gmail threads",
      description:
        "Search email threads in the selected account. Returns each thread's threadId, " +
        "messageCount, viewUrl, and up to the 5 most recent messages (id, viewUrl, from, to, cc, " +
        "bcc, date, labelIds, plus subject and snippet in the default view). Message BODIES are " +
        "NOT returned — use get_thread to read every message in full.\n\n" +
        "`view`: THREAD_VIEW_MINIMAL (default) as above; THREAD_VIEW_METADATA_ONLY omits subject " +
        "and snippet; THREAD_VIEW_SUMMARY returns only the latest message per thread; " +
        "THREAD_VIEW_IDS_ONLY returns only thread IDs (fast; good for counting or batch actions).\n\n" +
        SEARCH_SYNTAX_DOC +
        "\n\nDrafts are excluded by default. Trash & spam are excluded unless includeTrash is true. " +
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
          .describe("Include threads in Trash and Spam. Defaults to false."),
        view: z
          .enum([
            "THREAD_VIEW_UNSPECIFIED",
            "THREAD_VIEW_MINIMAL",
            "THREAD_VIEW_METADATA_ONLY",
            "THREAD_VIEW_SUMMARY",
            "THREAD_VIEW_IDS_ONLY",
          ])
          .optional()
          .describe("Which fields to populate per thread. Defaults to THREAD_VIEW_MINIMAL."),
        ...accountField,
      },
    },
    async ({ query, pageSize, pageToken, includeTrash, view, account }) =>
      withAccount(account, (auth, ctx) =>
        searchThreads(auth, ctx, { query, pageSize, pageToken, includeTrash, view }),
      ),
  );

  // --- get_thread ---------------------------------------------------------
  server.registerTool(
    "get_thread",
    {
      title: "Get a Gmail thread",
      description:
        "Fetch a thread and all of its messages from the selected account, with the thread's " +
        "viewUrl and messageCount. Draft messages in the thread are omitted (use list_drafts / " +
        "get_draft).\n\nmessageFormat:\n" +
        FORMAT_DOC +
        "\n\nEach body is returned in a ~50KB window. If a message has bodyTruncated: true, call " +
        "get_message with its id and bodyOffset=nextBodyOffset to read the rest. Raw attachment " +
        "bytes are never returned.",
      inputSchema: {
        threadId: z.string().min(1).describe("The thread ID (e.g. from search_threads results)."),
        messageFormat: messageFormatEnum(false),
        ...accountField,
      },
    },
    async ({ threadId, messageFormat, account }) =>
      withAccount(account, (auth, ctx) => getThread(auth, ctx, { threadId, messageFormat })),
  );

  // --- get_message --------------------------------------------------------
  server.registerTool(
    "get_message",
    {
      title: "Get a Gmail message",
      description:
        "Fetch a single message by its message ID (from get_thread or search_threads). Use this to " +
        "read one specific email in detail, or to page through a long body with bodyOffset. Not for " +
        "drafts — use get_draft.\n\nmessageFormat:\n" +
        FORMAT_DOC +
        "\n  • RAW: the raw RFC 2822 source (paged with bodyOffset).",
      inputSchema: {
        messageId: z.string().min(1).describe("The message ID to fetch."),
        messageFormat: messageFormatEnum(true),
        ...bodyWindowFields,
        ...accountField,
      },
    },
    async ({ messageId, messageFormat, bodyOffset, htmlBodyOffset, account }) =>
      withAccount(account, (auth, ctx) =>
        getMessage(auth, ctx, { messageId, messageFormat, bodyOffset, htmlBodyOffset }),
      ),
  );

  // --- create_draft -------------------------------------------------------
  server.registerTool(
    "create_draft",
    {
      title: "Create a Gmail draft",
      description:
        "Create a draft email in the selected account. Returns draftId, messageId, threadId, and a " +
        "viewUrl that opens the draft in Gmail. This server creates drafts ONLY — it never sends " +
        "mail.\n\n" +
        "Recipients (to/cc/bcc) should be plain email addresses (\"user@example.com\"). `body` is " +
        "plain text — do NOT format it with Markdown; use `htmlBody` for rich text. When both are " +
        "given, `body` is the plain-text alternative.\n\n" +
        "Replies: set `replyToMessageId` to the message being replied to. The draft joins that " +
        "thread, gets In-Reply-To/References headers, inherits \"Re: <subject>\" unless you supply " +
        "a subject, and — if `to` is omitted — is addressed to the original's Reply-To/From (or, " +
        "for your own sent message, its recipients). The original message is quoted below your " +
        "text unless quoteOriginal is false.\n\n" +
        "Set includeSignature: true to append the account's Gmail signature.\n\n" +
        "Attachments: array of { filename, mimeType, content (base64), inline? }; combined size " +
        "≤ 25MB (link larger files from Drive). To show an inline image, set inline: true and use " +
        "<img src=\"cid:attN\"> in htmlBody, where N is the attachment's zero-based position in " +
        "`attachments` (cid:<filename> also works).",
      inputSchema: {
        to: z
          .array(z.string())
          .optional()
          .describe(
            "Primary recipients as plain email addresses. Optional: replies default to the original " +
              "sender, and a draft may be saved without recipients.",
          ),
        cc: z.array(z.string()).optional().describe("CC recipients (plain email addresses)."),
        bcc: z.array(z.string()).optional().describe("BCC recipients (plain email addresses)."),
        subject: z.string().optional().describe("Subject line. Defaults to empty (or inherited on replies)."),
        body: z
          .string()
          .optional()
          .describe("Plain-text body (no Markdown). Becomes the text/plain alternative when htmlBody is also set."),
        htmlBody: z.string().optional().describe("HTML body (rich-text version of the email)."),
        replyToMessageId: z
          .string()
          .optional()
          .describe("Message ID to reply to; threads the draft, sets reply headers, and quotes the original."),
        quoteOriginal: z
          .boolean()
          .optional()
          .describe("When replying, append the quoted original message below your text. Defaults to true."),
        includeSignature: z
          .boolean()
          .optional()
          .describe("Append the account's configured Gmail signature. Defaults to false."),
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
                .describe("If true, embed inline; reference from htmlBody as cid:attN (N = position in attachments)."),
            }),
          )
          .optional()
          .describe("Attachments to include; combined size ≤ 25MB."),
        ...accountField,
      },
    },
    async ({ account, ...params }) =>
      withAccount(account, (auth, ctx) => createDraft(auth, ctx, params)),
  );

  // --- list_drafts --------------------------------------------------------
  server.registerTool(
    "list_drafts",
    {
      title: "List Gmail drafts",
      description:
        "List draft emails in the selected account, optionally filtered by a Gmail search `query` " +
        "(same syntax as search_threads; only drafts are searched). Each draft includes draftId, " +
        "messageId, threadId, subject, to, cc, bcc, date, snippet, and viewUrl. Set view to " +
        "DRAFT_VIEW_FULL to also include each draft's plain-text body. Use get_draft for one " +
        "draft in full.",
      inputSchema: {
        query: z.string().optional().describe("Optional Gmail search query to filter drafts."),
        view: z
          .enum(["DRAFT_VIEW_UNSPECIFIED", "DRAFT_VIEW_METADATA_ONLY", "DRAFT_VIEW_FULL"])
          .optional()
          .describe("DRAFT_VIEW_FULL adds the plain-text body. Defaults to metadata only."),
        pageSize: pageSizeField(50, 20),
        pageToken: pageTokenField,
        ...accountField,
      },
    },
    async ({ query, view, pageSize, pageToken, account }) =>
      withAccount(account, (auth, ctx) => listDrafts(auth, ctx, { query, view, pageSize, pageToken })),
  );

  // --- get_draft ----------------------------------------------------------
  server.registerTool(
    "get_draft",
    {
      title: "Get a Gmail draft",
      description:
        "Fetch a single draft by its draftId (from list_drafts or create_draft), including a " +
        "viewUrl that opens it in the Gmail composer.\n\nmessageFormat:\n" +
        FORMAT_DOC +
        "\n  • RAW: the raw RFC 2822 source.",
      inputSchema: {
        draftId: z.string().min(1).describe("The draft ID to fetch."),
        messageFormat: messageFormatEnum(true),
        ...bodyWindowFields,
        ...accountField,
      },
    },
    async ({ draftId, messageFormat, bodyOffset, htmlBodyOffset, account }) =>
      withAccount(account, (auth, ctx) =>
        getDraft(auth, ctx, { draftId, messageFormat, bodyOffset, htmlBodyOffset }),
      ),
  );

  // --- delete_draft -------------------------------------------------------
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
      withAccount(account, (auth, ctx) => deleteDraft(auth, ctx, { draftId })),
  );

  // --- list_labels --------------------------------------------------------
  server.registerTool(
    "list_labels",
    {
      title: "List Gmail labels",
      description:
        "List the labels in the selected account (id, name, type, and colors) — system labels " +
        "(INBOX, STARRED, UNREAD, IMPORTANT, SENT, DRAFT, SPAM, TRASH, CATEGORY_*) and user labels. " +
        "Use a label's `id` with the label/unlabel/update_message_labels tools, and its `name` with " +
        "the search operator label:<name>. DRAFT and SENT cannot be set on messages.\n\n" +
        "Inbox tabs are system labels: CATEGORY_PERSONAL (Primary), CATEGORY_SOCIAL, " +
        "CATEGORY_PROMOTIONS, CATEGORY_UPDATES, CATEGORY_FORUMS. A message has at most one " +
        "category: adding one moves it to that tab and removes the previous one; removing a " +
        "category without adding another moves it to Primary.",
      inputSchema: {
        includeSystem: z
          .boolean()
          .optional()
          .describe("Include system labels. Defaults to true; set false for user labels only."),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Maximum number of labels to return. If omitted, all labels are returned."),
        pageToken: pageTokenField,
        ...accountField,
      },
    },
    async ({ includeSystem, pageSize, pageToken, account }) =>
      withAccount(account, (auth, ctx) => listLabels(auth, ctx, { includeSystem, pageSize, pageToken })),
  );

  // --- create_label -------------------------------------------------------
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
      withAccount(account, (auth, ctx) => createLabel(auth, ctx, { name, textColor, backgroundColor })),
  );

  // --- update_label -------------------------------------------------------
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
      withAccount(account, (auth, ctx) =>
        updateLabel(auth, ctx, { labelId, name, textColor, backgroundColor }),
      ),
  );

  // --- delete_label -------------------------------------------------------
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
      withAccount(account, (auth, ctx) => deleteLabel(auth, ctx, { labelId })),
  );

  // --- label_message / unlabel_message / update_message_labels -----------
  const labelIdsField = (verb: string) =>
    z
      .array(z.string())
      .min(1)
      .describe(
        `Label IDs to ${verb} — system IDs (INBOX, STARRED, UNREAD, IMPORTANT, CATEGORY_*) or user ` +
          "label IDs from list_labels. Not display names.",
      );

  server.registerTool(
    "label_message",
    {
      title: "Add labels to a message",
      description:
        "Add one or more labels to a single message. labelIds must be label IDs, not display names " +
        "(see list_labels). Find message IDs via get_thread. To move a message to another inbox tab, " +
        "add the target CATEGORY_* label. To trash or report spam, use trash_message / " +
        "mark_message_spam instead.",
      inputSchema: {
        messageId: z.string().min(1).describe("The message ID to label."),
        labelIds: labelIdsField("add"),
        ...accountField,
      },
    },
    async ({ messageId, labelIds, account }) =>
      withAccount(account, (auth, ctx) =>
        modifyMessageLabels(auth, ctx, { messageId, addLabelIds: labelIds }),
      ),
  );

  server.registerTool(
    "unlabel_message",
    {
      title: "Remove labels from a message",
      description:
        "Remove one or more labels from a single message (e.g. UNREAD to mark read, INBOX to " +
        "archive). labelIds must be label IDs, not display names. Find message IDs via get_thread.",
      inputSchema: {
        messageId: z.string().min(1).describe("The message ID to unlabel."),
        labelIds: labelIdsField("remove"),
        ...accountField,
      },
    },
    async ({ messageId, labelIds, account }) =>
      withAccount(account, (auth, ctx) =>
        modifyMessageLabels(auth, ctx, { messageId, removeLabelIds: labelIds }),
      ),
  );

  server.registerTool(
    "update_message_labels",
    {
      title: "Add and remove message labels",
      description:
        "Atomically add and/or remove labels on a single message in one call — e.g. move between " +
        "labels by adding the target and removing the current one. At least one of addLabelIds or " +
        "removeLabelIds is required. For inbox tabs, adding the target CATEGORY_* label is enough; " +
        "Gmail removes the previous category automatically.",
      inputSchema: {
        messageId: z.string().min(1).describe("The message ID to modify."),
        addLabelIds: z.array(z.string()).optional().describe("Label IDs to add (system or user)."),
        removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove (system or user)."),
        ...accountField,
      },
    },
    async ({ messageId, addLabelIds, removeLabelIds, account }) =>
      withAccount(account, (auth, ctx) =>
        modifyMessageLabels(auth, ctx, { messageId, addLabelIds, removeLabelIds }),
      ),
  );

  // --- label_thread / unlabel_thread -------------------------------------
  server.registerTool(
    "label_thread",
    {
      title: "Add labels to a thread",
      description:
        "Add one or more labels to every message currently in a thread. labelIds must be label IDs, " +
        "not display names (see list_labels). Find thread IDs via search_threads. To trash or report " +
        "spam, use trash_thread / mark_thread_spam instead.",
      inputSchema: {
        threadId: z.string().min(1).describe("The thread ID to label."),
        labelIds: labelIdsField("add"),
        ...accountField,
      },
    },
    async ({ threadId, labelIds, account }) =>
      withAccount(account, (auth, ctx) =>
        modifyThreadLabels(auth, ctx, { threadId, addLabelIds: labelIds }),
      ),
  );

  server.registerTool(
    "unlabel_thread",
    {
      title: "Remove labels from a thread",
      description:
        "Remove one or more labels from every message in a thread (e.g. INBOX to archive the whole " +
        "thread). labelIds must be label IDs, not display names. Find thread IDs via search_threads.",
      inputSchema: {
        threadId: z.string().min(1).describe("The thread ID to unlabel."),
        labelIds: labelIdsField("remove"),
        ...accountField,
      },
    },
    async ({ threadId, labelIds, account }) =>
      withAccount(account, (auth, ctx) =>
        modifyThreadLabels(auth, ctx, { threadId, removeLabelIds: labelIds }),
      ),
  );

  // --- trash / untrash / spam --------------------------------------------
  const messageIdField = (what: string) => ({
    messageId: z.string().min(1).describe(`The ID of the message to ${what}.`),
  });
  const threadIdField = (what: string) => ({
    threadId: z.string().min(1).describe(`The ID of the thread to ${what}.`),
  });

  server.registerTool(
    "trash_message",
    {
      title: "Move a message to Trash",
      description:
        "Move one message to Trash (soft delete; recoverable with untrash_message for 30 days). " +
        "This is the default when a user asks to delete or get rid of a message. To trash a whole " +
        "conversation (or a single-message thread), prefer trash_thread. Find message IDs via get_thread.",
      inputSchema: { ...messageIdField("move to Trash"), ...accountField },
    },
    async ({ messageId, account }) =>
      withAccount(account, (auth, ctx) => trash(auth, ctx, { kind: "message", id: messageId })),
  );

  server.registerTool(
    "trash_thread",
    {
      title: "Move a thread to Trash",
      description:
        "Move an entire thread to Trash (soft delete; recoverable with untrash_thread for 30 days). " +
        "This is the default when a user asks to delete a conversation or email.",
      inputSchema: { ...threadIdField("move to Trash"), ...accountField },
    },
    async ({ threadId, account }) =>
      withAccount(account, (auth, ctx) => trash(auth, ctx, { kind: "thread", id: threadId })),
  );

  server.registerTool(
    "untrash_message",
    {
      title: "Restore a message from Trash",
      description:
        "Remove one message from Trash. This does not put it back in the Inbox; add the INBOX " +
        "label separately if needed.",
      inputSchema: { ...messageIdField("remove from Trash"), ...accountField },
    },
    async ({ messageId, account }) =>
      withAccount(account, (auth, ctx) => untrash(auth, ctx, { kind: "message", id: messageId })),
  );

  server.registerTool(
    "untrash_thread",
    {
      title: "Restore a thread from Trash",
      description:
        "Remove an entire thread from Trash. This does not put it back in the Inbox; add the INBOX " +
        "label separately if needed.",
      inputSchema: { ...threadIdField("remove from Trash"), ...accountField },
    },
    async ({ threadId, account }) =>
      withAccount(account, (auth, ctx) => untrash(auth, ctx, { kind: "thread", id: threadId })),
  );

  server.registerTool(
    "mark_message_spam",
    {
      title: "Report a message as spam",
      description:
        "Mark one message as Spam (adds SPAM, removes INBOX). To mark a whole conversation, prefer " +
        "mark_thread_spam.",
      inputSchema: { ...messageIdField("mark as Spam"), ...accountField },
    },
    async ({ messageId, account }) =>
      withAccount(account, (auth, ctx) => markSpam(auth, ctx, { kind: "message", id: messageId })),
  );

  server.registerTool(
    "mark_thread_spam",
    {
      title: "Report a thread as spam",
      description:
        "Mark every message currently in a thread as Spam (adds SPAM, removes INBOX). Use this even " +
        "for single-message threads.",
      inputSchema: { ...threadIdField("mark as Spam"), ...accountField },
    },
    async ({ threadId, account }) =>
      withAccount(account, (auth, ctx) => markSpam(auth, ctx, { kind: "thread", id: threadId })),
  );

  server.registerTool(
    "unmark_message_spam",
    {
      title: "Unmark a message as spam",
      description:
        "Remove the Spam label from one message. This does not put it back in the Inbox; add the " +
        "INBOX label separately if needed.",
      inputSchema: { ...messageIdField("unmark as Spam"), ...accountField },
    },
    async ({ messageId, account }) =>
      withAccount(account, (auth, ctx) => unmarkSpam(auth, ctx, { kind: "message", id: messageId })),
  );

  server.registerTool(
    "unmark_thread_spam",
    {
      title: "Unmark a thread as spam",
      description:
        "Remove the Spam label from every message in a thread. This does not put it back in the " +
        "Inbox; add the INBOX label separately if needed.",
      inputSchema: { ...threadIdField("unmark as Spam"), ...accountField },
    },
    async ({ threadId, account }) =>
      withAccount(account, (auth, ctx) => unmarkSpam(auth, ctx, { kind: "thread", id: threadId })),
  );

  const labelOptionField = {
    labelOption: z
      .enum(["LABEL_OPTION_UNSPECIFIED", "TRASH", "SPAM"])
      .describe("Which sensitive label to apply: TRASH or SPAM."),
  };

  server.registerTool(
    "apply_sensitive_message_label",
    {
      title: "Apply Trash or Spam to a message",
      description:
        "Prefer trash_message or mark_message_spam instead. Applies Trash or Spam to exactly one " +
        "message; for a whole thread prefer trash_thread or mark_thread_spam.",
      inputSchema: { ...messageIdField("label"), ...labelOptionField, ...accountField },
    },
    async ({ messageId, labelOption, account }) =>
      withAccount(account, (auth, ctx) =>
        applySensitiveLabel(auth, ctx, { kind: "message", id: messageId }, labelOption),
      ),
  );

  server.registerTool(
    "apply_sensitive_thread_label",
    {
      title: "Apply Trash or Spam to a thread",
      description:
        "Prefer trash_thread or mark_thread_spam instead. Applies Trash or Spam to every message " +
        "currently in one thread.",
      inputSchema: { ...threadIdField("label"), ...labelOptionField, ...accountField },
    },
    async ({ threadId, labelOption, account }) =>
      withAccount(account, (auth, ctx) =>
        applySensitiveLabel(auth, ctx, { kind: "thread", id: threadId }, labelOption),
      ),
  );

  // --- list_accounts ------------------------------------------------------
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
