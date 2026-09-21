const http = require("http");
const { URL } = require("url");
const { google } = require("googleapis");
const readline = require("readline");
const { randomBytes } = require("crypto");

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const clientId =
    process.env.GOOGLE_CLIENT_ID ||
    await ask("Google OAuth Client ID: ");

  const clientSecret =
    process.env.GOOGLE_CLIENT_SECRET ||
    await ask("Google OAuth Client Secret: ");

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    REDIRECT_URI
  );
  if (!clientId.trim() || !clientSecret.trim()) {
    throw new Error("missing_credentials");
  }
  const state = randomBytes(32).toString("hex");

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    state,
    scope: [
      "https://www.googleapis.com/auth/drive.file",
    ],
  });

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, REDIRECT_URI);

      if (requestUrl.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      if (requestUrl.searchParams.get("state") !== state) {
        res.writeHead(400);
        res.end("Invalid OAuth state. Open the URL printed by this script again.");
        return;
      }
      if (requestUrl.searchParams.has("error")) {
        res.writeHead(400);
        res.end("Authorization was denied. See the terminal for next steps.");
        console.error("Authorization denied. Add your Google account as a test user " +
          "if the app is in Testing, then run this script and approve access.");
        process.exitCode = 1;
        server.close();
        return;
      }

      const code = requestUrl.searchParams.get("code");

      if (!code) {
        res.writeHead(400);
        res.end("Authorization code missing.");
        return;
      }

      const { tokens } = await oauth2Client.getToken(code);

      if (!tokens.refresh_token) {
        throw new Error("missing_refresh_token");
      }

      res.writeHead(200, {
        "Content-Type": "text/plain",
      });

      res.end(
        "Authorization completed. You can close this browser window."
      );

      console.log("\nStore this token securely; do not paste it into chat or logs.\n");
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log("Update Lambda GOOGLE_REFRESH_TOKEN and use this same client ID and secret.");

      server.close();
    } catch (error) {
      reportError(error);

      res.writeHead(500);
      res.end("OAuth failed.");

      server.close();
      process.exitCode = 1;
    }
  });

  server.on("error", (error) => {
    reportError(error);
    process.exitCode = 1;
  });
  server.listen(PORT, "localhost", () => {
    console.log("\nFor scheduled backups, set Google Auth Platform > Audience to " +
      "Production before authorizing. Testing refresh tokens expire after 7 days.");
    console.log("Use a Desktop app OAuth client. Open this URL on this computer:\n");
    console.log(authUrl);
    console.log(
      `\nWaiting for Google OAuth callback on ${REDIRECT_URI} ...`
    );
  });
}

function reportError(error) {
  const reason = error?.response?.data?.error || error?.code || error?.message;
  const guidance = {
    missing_credentials: "Client ID and client secret are required.",
    missing_refresh_token: "No refresh token returned. Remove this app's access in " +
      "your Google account connections and authorize again. This revokes existing grants.",
    invalid_grant: "Authorization code expired or was already used. Run the script " +
      "again and open the new URL; approve access only once.",
    invalid_client: "Check the client ID and secret belong to the same Desktop app OAuth client.",
    EADDRINUSE: "Port 3000 is busy. Close the previous token generator or other listener and retry.",
  };
  // Never print Google HTTP errors: their request bodies can contain credentials.
  console.error(guidance[reason] || "OAuth failed. Check the Desktop app client credentials, " +
    "internet connection and consent screen configuration, then retry.");
}

main().catch((error) => {
  reportError(error);
  process.exit(1);
});
