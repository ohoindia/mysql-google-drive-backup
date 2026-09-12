const { spawn } = require("child_process");
const zlib = require("zlib");
const { PassThrough } = require("stream");
const { google } = require("googleapis");

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

exports.handler = async () => {
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

  dump.stdout.pipe(gzip).pipe(uploadStream);

  let dumpError = "";

  dump.stderr.on("data", (data) => {
    const message = data.toString();
    dumpError += message;
    console.error(`[mysqldump] ${message.trim()}`);
  });

  dump.stdout.on("error", (error) => {
    console.error("mysqldump stdout error:", error);
  });

  gzip.on("error", (error) => {
    console.error("gzip error:", error);
    uploadStream.destroy(error);
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

  const uploadPromise = drive.files.create({
    requestBody: {
      name: fileName,
      parents: [GOOGLE_DRIVE_FOLDER_ID],
    },
    media: {
      mimeType: "application/gzip",
      body: uploadStream,
    },
    fields: "id,name,size,webViewLink,createdTime",
  });

  try {
    const [, uploadResult] = await Promise.all([
      dumpPromise,
      uploadPromise,
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
    console.error("Backup failed:", error);

    // Stop the dump if Drive upload fails.
    if (!dump.killed) {
      dump.kill("SIGTERM");
    }

    throw error;
  }
};
