# AWS RDS MySQL Backup to Personal Google Drive

This project runs as an AWS Lambda container image. It:

1. Connects to an AWS-hosted MySQL/RDS database.
2. Runs `mysqldump`.
3. Compresses the dump using gzip.
4. Streams the compressed backup directly to a folder in your personal Google Drive.
5. Can be invoked on a schedule using Amazon EventBridge Scheduler.

The backup is streamed and is not accumulated in Lambda memory or written as a complete file under `/tmp`.

## Project structure

```text
mysql-rds-google-drive-backup/
├── Dockerfile
├── .dockerignore
├── .env.example
├── .gitignore
├── index.js
├── package.json
├── README.md
└── scripts/
    └── generate-refresh-token.js
```

## 1. Google Cloud setup for Personal Google Drive

1. Open Google Cloud Console.
2. Create or select a project.
3. Enable **Google Drive API**.
4. Configure the OAuth consent screen.
5. Create an OAuth client ID.
6. Choose **Desktop app** as the OAuth client type.
7. Copy the client ID and client secret.

For an app still in Google OAuth "Testing" mode, add your personal Google account as a test user.

## 2. Generate a Google refresh token

On your local computer:

```bash
npm install
```

Set the client ID and secret or enter them when prompted.

Windows PowerShell:

```powershell
$env:GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
$env:GOOGLE_CLIENT_SECRET="your-client-secret"
npm run generate-google-token
```

macOS/Linux:

```bash
export GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="your-client-secret"
npm run generate-google-token
```

The script opens an OAuth flow. After you approve access with your personal Google account, it prints:

```text
GOOGLE_REFRESH_TOKEN=1//...
```

Save that token securely.

## 3. Create a Google Drive folder

Create a folder in My Drive, for example:

```text
My Drive
└── Database Backups
```

A folder URL looks similar to:

```text
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv
```

Set:

```text
GOOGLE_DRIVE_FOLDER_ID=1AbCdEfGhIjKlMnOpQrStUv
```

## 4. Lambda environment variables

Configure:

```text
DB_HOST=<RDS endpoint>
DB_PORT=3306
DB_USER=<MySQL user>
DB_PASSWORD=<MySQL password>
DB_NAME=<database name>

GOOGLE_CLIENT_ID=<OAuth client ID>
GOOGLE_CLIENT_SECRET=<OAuth client secret>
GOOGLE_REFRESH_TOKEN=<OAuth refresh token>
GOOGLE_DRIVE_FOLDER_ID=<Drive folder ID>
```

For production, store DB credentials and Google OAuth secrets in AWS Secrets Manager rather than plain environment variables.

## 5. Build the Lambda container

Authenticate Docker to your ECR registry, then:

```bash
docker build -t mysql-rds-google-drive-backup .
```

Create an ECR repository if required:

```bash
aws ecr create-repository \
  --repository-name mysql-rds-google-drive-backup
```

Tag and push:

```bash
docker tag mysql-rds-google-drive-backup:latest \
  <AWS_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/mysql-rds-google-drive-backup:latest

docker push \
  <AWS_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/mysql-rds-google-drive-backup:latest
```

Then create an AWS Lambda function using **Container image** and select the ECR image.

## 6. Recommended Lambda settings

For a database currently around 130 MB:

```text
Memory:             1024-2048 MB
Timeout:            10-15 minutes
Architecture:       x86_64
Ephemeral storage:  512 MB is sufficient for this streaming implementation
```

The Lambda must be able to reach both:

- the RDS MySQL endpoint
- Google's HTTPS APIs

### Private RDS

If RDS is private, put the Lambda in the appropriate VPC/subnets and allow TCP 3306 from the Lambda security group to the RDS security group.

Because Google Drive is external to AWS, a VPC-attached Lambda in private subnets normally requires outbound Internet connectivity through a NAT gateway/NAT instance.

## 7. EventBridge Scheduler

Create a schedule whose target is this Lambda.

Example: every day at 2:00 AM India time:

```text
Schedule expression:
cron(0 2 * * ? *)

Timezone:
Asia/Kolkata
```

Use your preferred timezone and execution time.

## 8. Backup filename

Files are generated with names similar to:

```text
your_database_2026-09-11T02-00-00-000Z.sql.gz
```

## 9. Restore

Download the `.sql.gz` backup and extract it.

Linux/macOS:

```bash
gunzip your_database_2026-09-11T02-00-00-000Z.sql.gz
```

Restore:

```bash
mysql \
  -h <host> \
  -P 3306 \
  -u <user> \
  -p \
  <database> \
  < your_database_2026-09-11T02-00-00-000Z.sql
```

## 10. MySQL permissions

The database user must have sufficient permissions to read all objects being backed up.

The dump command uses:

```text
--single-transaction
--quick
--routines
--triggers
--events
--no-tablespaces
--hex-blob
--default-character-set=utf8mb4
```

If the user cannot read routines/events, remove those dump options or grant the required privileges.

## 11. Security recommendations

Do not commit `.env`, database passwords, OAuth client secrets, or refresh tokens to Git.

For production, use AWS Secrets Manager for:

- DB username/password
- Google client ID/client secret
- Google refresh token

Also consider:

- CloudWatch alarms for Lambda failures.
- Google Drive retention/cleanup rules implemented as a separate maintenance job.
- RDS automated snapshots in addition to logical SQL backups.
