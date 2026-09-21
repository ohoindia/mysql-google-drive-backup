const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

function load(file, globals) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), {
    module, exports: module.exports, require, ...globals,
  });
  return module.exports;
}

function setup({ backup = "success", email = "success", missing } = {}) {
  const env = Object.fromEntries([
    "DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME", "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_DRIVE_FOLDER_ID",
    "BREVO_SMTP_KEY", "BREVO_SMTP_LOGIN",
  ].map((key) => [key, "secret-placeholder"]));
  env.BREVO_EMAIL_FROM = "backups@example.com";
  env.BREVO_EMAIL_TO = "one@example.com, two@example.com";
  if (missing) delete env[missing];
  const logs = [], requests = [];
  const globals = {
    process: { env },
    console: { log: (...args) => logs.push(args.join(" ")), error: (...args) => logs.push(args.join(" ")) },
    require(name) {
      if (name !== "nodemailer") return require(name);
      return { createTransport(options) {
        return {
          async sendMail(body) {
            requests.push({ options, body });
            if (email === "timeout" || email === "auth") throw new Error("sensitive provider error");
            return { accepted: email === "rejected" ? ["one@example.com"] : ["one@example.com", "two@example.com"], rejected: email === "rejected" ? ["two@example.com"] : [] };
          },
          close() {},
        };
      } };
    },
  };
  const notifications = load("notifications.js", globals);
  const dump = new EventEmitter();
  dump.stdout = new PassThrough(); dump.stderr = new PassThrough();
  dump.kill = () => { dump.killed = true; dump.emit("close", 1); };
  class OAuth2 { setCredentials() {} }
  const handler = load("index.js", {
    ...globals,
    require(name) {
      if (name === "./notifications") return notifications;
      if (name === "child_process") return { spawn() {
        setImmediate(() => {
          if (backup === "spawn") { dump.emit("error", new Error("sensitive spawn error")); return; }
          if (backup === "stream") { dump.stdout.destroy(new Error("sensitive stream error")); return; }
          dump.stdout.end("SELECT 1;");
          dump.emit("close", backup === "dump" ? 1 : 0);
        });
        return dump;
      } };
      if (name === "googleapis") return { google: { auth: { OAuth2 }, drive: () => ({ files: {
        create: async ({ media }) => {
          if (backup === "grant") throw { response: { data: { error: "invalid_grant" } }, config: { body: "sensitive refresh token" } };
          for await (const chunk of media.body) { /* Consume the actual gzip stream. */ }
          return { data: { id: "file-id", name: "backup.sql.gz", size: "29", webViewLink: "https://drive.google.com/file/d/file-id/view" } };
        },
      } }) } };
      return require(name);
    },
  }).handler;
  return { handler, requests, logs, dump };
}

test("successful backup sends details to separate Brevo recipients", async () => {
  const { handler, requests } = setup();
  const result = await handler({}, { awsRequestId: "request-123" });
  assert.equal(result.notification.status, "accepted");
  assert.equal(requests.length, 1);
  const { body, options } = requests[0];
  assert.equal(options.host, "smtp-relay.brevo.com");
  assert.equal(options.port, 587);
  assert.equal(options.requireTLS, true);
  assert.equal(options.auth.pass, "secret-placeholder");
  assert.equal(body.bcc.length, 2);
  assert.equal(body.to, undefined);
  assert.match(body.subject, /SUCCESS/);
  assert.match(body.text, /file-id/);
  assert.match(body.text, /request-123/);
  assert(!body.text.includes("sensitive"));
});

for (const backup of ["grant", "dump", "spawn", "stream"]) {
  test(`${backup} failure sends one failure email and still rejects`, async () => {
    const { handler, requests, logs } = setup({ backup });
    await assert.rejects(handler(), backup === "grant" ? /authorization expired/ : /Backup failed/);
    assert.equal(requests.length, 1);
    assert.match(requests[0].body.subject, /FAILED/);
    assert.match(requests[0].body.text, /Drive file ID: Not available/);
    assert(!JSON.stringify(requests[0].body).includes("sensitive"));
    assert(!logs.join(" ").includes("sensitive"));
  });
}

test("missing backup configuration sends failure email", async () => {
  const { handler, requests } = setup({ missing: "DB_HOST" });
  await assert.rejects(handler(), /Missing required environment variable: DB_HOST/);
  assert.match(requests[0].body.subject, /FAILED/);
});

for (const email of ["auth", "rejected", "timeout"]) {
  test(`${email} email failure preserves successful backup`, async () => {
    const { handler, requests, logs } = setup({ email });
    const result = await handler();
    assert.equal(result.statusCode, 200);
    assert.equal(result.notification.status, "failed");
    assert.equal(requests.length, 1);
    assert(!logs.join(" ").includes("sensitive"));
  });
}

test("Brevo failure does not replace Google authorization failure", async () => {
  const { handler, requests } = setup({ backup: "grant", email: "timeout" });
  await assert.rejects(handler(), /Google Drive authorization expired/);
  assert.equal(requests.length, 1);
});

test("missing Brevo settings are reported without preventing backup", async () => {
  const { handler, requests, logs } = setup({ missing: "BREVO_SMTP_KEY" });
  const result = await handler();
  assert.equal(result.notification.reason, "missing_configuration");
  assert.equal(requests.length, 0);
  assert(logs.join(" ").includes("BREVO_SMTP_KEY"));
});
