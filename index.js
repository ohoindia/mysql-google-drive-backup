const { spawn } = require("child_process");
const zlib = require("zlib");
const { PassThrough } = require("stream");
const { pipeline } = require("stream/promises");
const { google } = require("googleapis");
const { notifyBackup } = require("./notifications");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function createDriveClient() {
  const clientId = requireEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
  const refreshToken = requireEnv("GOOGLE_REFRESH_TOKEN");

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return google.drive({
    version: "v3",
    auth: oauth2Client,
  });
}

async function runBackup() {
  const DB_HOST = requireEnv("DB_HOST");
  const DB_USER = requireEnv("DB_USER");
  const DB_PASSWORD = requireEnv("DB_PASSWORD");
  const DB_NAME = requireEnv("DB_NAME");

  const DB_PORT = process.env.DB_PORT || "3306";
  const GOOGLE_DRIVE_FOLDER_ID = requireEnv("GOOGLE_DRIVE_FOLDER_ID");

  const drive = createDriveClient();

  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[:.]/g, "-");

  const fileName = `${DB_NAME}_${timestamp}.sql.gz`;

  console.log(`Starting backup for database: ${DB_NAME}`);
  console.log(`Destination file: ${fileName}`);

  const args = [
    `--host=${DB_HOST}`,
    `--port=${DB_PORT}`,
    `--user=${DB_USER}`,
    "--single-transaction",
    "--quick",
    "--routines",
    "--triggers",
    "--events",
    "--no-tablespaces",
    "--hex-blob",
    "--default-character-set=utf8mb4",
    DB_NAME,
  ];

  const dump = spawn("/usr/local/bin/mysqldump", args, {
    env: {
      ...process.env,
      MYSQL_PWD: DB_PASSWORD,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const gzip = zlib.createGzip({ level: 6 });
  const uploadStream = new PassThrough();

  const streamPromise = pipeline(dump.stdout, gzip, uploadStream);

  let dumpError = "";

  dump.stderr.on("data", (data) => {
    const message = data.toString();
    dumpError += message;
    console.error(`[mysqldump] ${message.trim()}`);
  });

  const dumpPromise = new Promise((resolve, reject) => {
    dump.on("error", (error) => {
      reject(new Error(`Unable to start mysqldump: ${error.message}`));
    });

    dump.on("close", (code) => {
      if (code === 0) {
        console.log("mysqldump completed successfully.");
        resolve();
      } else {
        reject(
          new Error(
            `mysqldump failed with exit code ${code}. ${dumpError}`
          )
        );
      }
    });
  });

  const uploadPromise = Promise.resolve().then(() => drive.files.create({
    requestBody: {
      name: fileName,
      parents: [GOOGLE_DRIVE_FOLDER_ID],
    },
    media: {
      mimeType: "application/gzip",
      body: uploadStream,
    },
    fields: "id,name,size,webViewLink,createdTime",
  }));

  try {
    const [, uploadResult] = await Promise.all([
      dumpPromise,
      uploadPromise,
      streamPromise,
    ]);

    const file = uploadResult.data;

    console.log("Backup uploaded successfully to Google Drive.");
    console.log(`Google Drive file ID: ${file.id}`);

    return {
      statusCode: 200,
      message: "MySQL backup uploaded successfully to Google Drive.",
      database: DB_NAME,
      fileName: file.name,
      fileId: file.id,
      fileSize: file.size || null,
      webViewLink: file.webViewLink || null,
      backupDate: now.toISOString(),
    };
  } catch (error) {
    // Gaxios errors contain request bodies, including the refresh token.
    // Throw a fresh error too: Lambda logs unhandled exceptions automatically.
    const message = error?.response?.data?.error === "invalid_grant"
      ? "Google Drive authorization expired or was revoked. Set the OAuth app " +
        "to Production, run npm run generate-google-token locally, and update " +
        "Lambda GOOGLE_REFRESH_TOKEN using the same OAuth client credentials."
      : "Backup failed. Check database connectivity, Google Drive authorization, " +
        "and access to GOOGLE_DRIVE_FOLDER_ID.";
    console.error(message);

    // Stop the dump if Drive upload fails.
    if (!dump.killed) {
      dump.kill("SIGTERM");
    }
    uploadStream.destroy();
    gzip.destroy();
    dump.stdout.destroy();

    throw new Error(message);
  }
}

exports.handler = async (event, context) => {
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await runBackup();
  } catch (error) {
    // Only send known safe messages, never raw SDK errors or database output.
    const message = /^(Missing required environment variable: [A-Z_]+|Google Drive authorization expired or was revoked\.|Backup failed\.)/.test(error?.message || "")
      ? error.message
      : "Backup failed during initialization. Check the Lambda logs and configuration.";
    await notifyBackup({
      status: "FAILED",
      database: process.env.DB_NAME || "Unknown",
      backup_date: startedAt,
      file_name: "",
      file_id: "",
      file_size: "",
      drive_link: "",
      message,
      request_id: context?.awsRequestId || "",
    });
    throw new Error(message);
  }

  const notification = await notifyBackup({
    status: "SUCCESS",
    database: result.database,
    backup_date: result.backupDate,
    file_name: result.fileName,
    file_id: result.fileId,
    file_size: result.fileSize || "",
    drive_link: result.webViewLink || "",
    message: result.message,
    request_id: context?.awsRequestId || "",
  });
  return { ...result, notification };
};
