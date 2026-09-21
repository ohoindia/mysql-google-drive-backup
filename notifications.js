const nodemailer = require("nodemailer");

async function notifyBackup(variables) {
  let transport;
  try {
    const required = ["BREVO_SMTP_LOGIN", "BREVO_SMTP_KEY", "BREVO_EMAIL_FROM", "BREVO_EMAIL_TO"];
    const missing = required.filter((name) => !process.env[name]?.trim());
    if (missing.length) {
      console.error(`Brevo notification not sent. Missing configuration: ${missing.join(", ")}`);
      return { status: "failed", reason: "missing_configuration" };
    }
    const recipients = [...new Set(process.env.BREVO_EMAIL_TO.split(",").map((email) => email.trim()).filter(Boolean))];
    const sender = process.env.BREVO_EMAIL_FROM.trim();
    const validEmail = (email) => /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(email);
    if (!recipients.length || !recipients.every(validEmail) || !validEmail(sender)) {
      console.error("Brevo notification not sent. Check BREVO_EMAIL_FROM and BREVO_EMAIL_TO addresses.");
      return { status: "failed", reason: "invalid_addresses" };
    }
    transport = nodemailer.createTransport({
      host: "smtp-relay.brevo.com", port: 587, secure: false, requireTLS: true,
      auth: { user: process.env.BREVO_SMTP_LOGIN.trim(), pass: process.env.BREVO_SMTP_KEY.trim() },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 10000, dnsTimeout: 10000,
      logger: false, debug: false,
    });
    const info = await transport.sendMail({
      from: { name: process.env.BREVO_EMAIL_FROM_NAME || "Database Backup", address: sender },
      // Bcc keeps recipient addresses private. No saved template is needed.
      bcc: recipients.map((address) => ({ address })),
      subject: `MySQL backup ${variables.status}: ${variables.database}`.replace(/[\r\n]/g, " "),
      text: [
        `MySQL backup: ${variables.status}`, `Database: ${variables.database}`,
        `Started at (UTC): ${variables.backup_date}`, "", variables.message, "",
        `File: ${variables.file_name || "Not available"}`,
        `Drive file ID: ${variables.file_id || "Not available"}`,
        `Compressed size (bytes): ${variables.file_size || "Not available"}`,
        `Drive link: ${variables.drive_link || "Not available"}`,
        `Lambda request ID: ${variables.request_id || "Not available"}`,
      ].join("\n"),
      disableFileAccess: true, disableUrlAccess: true,
    });
    if (info.rejected?.length || info.accepted?.length !== recipients.length) {
      console.error("Brevo did not accept all notification recipients. Check transactional email logs.");
      return { status: "failed", reason: "provider_rejected" };
    }
    console.log("Backup notification accepted by Brevo.");
    return { status: "accepted" };
  } catch {
    // Never log SMTP errors or responses, which can contain credentials/account data.
    console.error("Brevo notification failed. Check SMTP credentials, sender verification, connectivity and email logs.");
    return { status: "failed", reason: "request_failed" };
  } finally {
    transport?.close();
  }
}

module.exports = { notifyBackup };
