const http = require("http");
const { URL } = require("url");
const { google } = require("googleapis");
const readline = require("readline");

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

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/drive.file",
    ],
  });

  console.log("\nOpen this URL in your browser:\n");
  console.log(authUrl);
  console.log(
    `\nAfter approval, Google will redirect to ${REDIRECT_URI}`
  );

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, REDIRECT_URI);

      if (requestUrl.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = requestUrl.searchParams.get("code");

      if (!code) {
        res.writeHead(400);
        res.end("Authorization code missing.");
        return;
      }

      const { tokens } = await oauth2Client.getToken(code);

      res.writeHead(200, {
        "Content-Type": "text/plain",
      });

      res.end(
        "Authorization completed. You can close this browser window."
      );

      console.log("\nOAuth tokens received.\n");

      if (tokens.refresh_token) {
        console.log("GOOGLE_REFRESH_TOKEN=");
        console.log(tokens.refresh_token);
      } else {
        console.log(
          "No refresh token was returned. Revoke the application's access " +
          "from your Google account and run this script again, or ensure " +
          "prompt=consent is being used."
        );
      }

      server.close();
    } catch (error) {
      console.error(error);

      res.writeHead(500);
      res.end("OAuth failed.");

      server.close();
      process.exitCode = 1;
    }
  });

  server.listen(PORT, () => {
    console.log(
      `\nWaiting for Google OAuth callback on ${REDIRECT_URI} ...`
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
