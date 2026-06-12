/**
 * `multi-gmail-mcp auth <alias>` — interactive OAuth flow.
 *
 * Spins up a localhost loopback server, opens the Google consent screen in a
 * browser, exchanges the returned code for a refresh token, looks up the
 * account's email via the Gmail profile, and stores it in accounts.json.
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import { AddressInfo } from "node:net";
import { URL } from "node:url";
import open from "open";
import { google } from "googleapis";
import {
  SCOPES,
  createOAuth2Client,
  upsertAccount,
  loadAccounts,
  accountsPath,
} from "./accounts.js";

const CALLBACK_PATH = "/oauth2callback";
/** Abandon the flow if the user never completes consent. */
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

function htmlResponse(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0b0c;color:#e8e8e8;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{max-width:480px;padding:32px;background:#161618;border-radius:12px;text-align:center;
box-shadow:0 8px 30px rgba(0,0,0,.4)}h1{font-size:20px;margin:0 0 8px}p{color:#a8a8a8;line-height:1.5}</style>
</head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

export async function runAuthCli(argv: string[]): Promise<void> {
  const alias = argv[0]?.trim();
  if (!alias) {
    console.error("Usage: multi-gmail-mcp auth <alias>");
    console.error("Example: multi-gmail-mcp auth work");
    process.exitCode = 1;
    return;
  }
  const makeDefault = argv.includes("--default");

  // Validate credentials up front so we fail fast with a clear message.
  let oauthClientError: Error | undefined;
  try {
    createOAuth2Client("http://localhost/oauth2callback");
  } catch (err) {
    oauthClientError = err as Error;
  }
  if (oauthClientError) {
    console.error(`\n✖ ${oauthClientError.message}\n`);
    process.exitCode = 1;
    return;
  }

  const state = randomBytes(16).toString("hex");

  const result = await new Promise<{ email: string } | { error: string }>((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        if (!req.url) return;
        const url = new URL(req.url, "http://localhost");
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end("Not found");
          return;
        }

        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" }).end(
            htmlResponse("Authorization failed", `Google returned: ${error}. You can close this tab.`),
          );
          cleanup();
          resolve({ error: `Authorization was denied or failed: ${error}` });
          return;
        }

        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        if (!code || returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" }).end(
            htmlResponse("Invalid request", "Missing code or state mismatch. Please re-run auth."),
          );
          cleanup();
          resolve({ error: "OAuth callback was missing a code or failed the state check." });
          return;
        }

        // Exchange the code using a client configured with the SAME redirect URI.
        const { port } = server.address() as AddressInfo;
        const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
        const client = createOAuth2Client(redirectUri);
        const { tokens } = await client.getToken(code);

        if (!tokens.refresh_token) {
          res.writeHead(200, { "Content-Type": "text/html" }).end(
            htmlResponse(
              "No refresh token returned",
              "Google did not return a refresh token. Revoke prior access at " +
                "myaccount.google.com/permissions and re-run auth.",
            ),
          );
          cleanup();
          resolve({
            error:
              "Google did not return a refresh token. Remove this app at " +
              "https://myaccount.google.com/permissions and run auth again.",
          });
          return;
        }

        client.setCredentials(tokens);
        const gmail = google.gmail({ version: "v1", auth: client });
        const profile = await gmail.users.getProfile({ userId: "me" });
        const email = profile.data.emailAddress ?? "(unknown)";

        upsertAccount(alias, email, tokens.refresh_token, makeDefault);

        res.writeHead(200, { "Content-Type": "text/html" }).end(
          htmlResponse(
            "✓ Account connected",
            `Alias <b>${alias}</b> is now linked to <b>${email}</b>. You can close this tab and return to the terminal.`,
          ),
        );
        cleanup();
        resolve({ email });
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" }).end(
          htmlResponse("Error", "Something went wrong completing authorization. Check the terminal."),
        );
        cleanup();
        resolve({ error: (err as Error).message });
      }
    });

    let timer: NodeJS.Timeout;
    function cleanup() {
      clearTimeout(timer);
      // Give the response a tick to flush before closing the socket.
      setTimeout(() => server.close(), 100);
    }

    server.listen(0, "127.0.0.1", async () => {
      const { port } = server.address() as AddressInfo;
      const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
      const client = createOAuth2Client(redirectUri);
      const authUrl = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent", // force a refresh_token even on re-auth
        scope: SCOPES,
        state,
      });

      console.log(`\nAuthorizing Gmail account for alias "${alias}"...`);
      console.log("Opening your browser for Google consent. If it doesn't open, visit:\n");
      console.log(authUrl + "\n");

      timer = setTimeout(() => {
        cleanup();
        resolve({ error: "Timed out waiting for authorization (5 minutes)." });
      }, AUTH_TIMEOUT_MS);

      try {
        await open(authUrl);
      } catch {
        // Browser couldn't be opened automatically; the URL was printed above.
      }
    });

    server.on("error", (err) => {
      resolve({ error: `Local OAuth server error: ${(err as Error).message}` });
    });
  });

  if ("error" in result) {
    console.error(`\n✖ Authorization failed: ${result.error}\n`);
    process.exitCode = 1;
    return;
  }

  const data = loadAccounts();
  const saved = data.accounts[alias];
  console.log(`\n✓ Connected "${alias}" → ${result.email}`);
  console.log(`  Stored in ${accountsPath()}${saved?.default ? " (default account)" : ""}`);
  console.log(`\nYou can now use this account via the "account" parameter ("${alias}" or "${result.email}").\n`);
}
