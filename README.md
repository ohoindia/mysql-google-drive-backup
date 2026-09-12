# AWS RDS MySQL Backup to Personal Google Drive

This project runs as an **AWS Lambda container image** and performs the following flow:

```text
Amazon EventBridge Scheduler
            |
            v
       AWS Lambda
            |
            v
     AWS RDS MySQL
            |
        mysqldump
            |
           gzip
            |
            v
 Personal Google Drive
```

The database dump is streamed through gzip and uploaded directly to Google Drive. The complete backup is not loaded into Lambda memory and does not need to be written to `/tmp`.

---

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

---

## 1. Prerequisites

Install the following on your development machine:

- AWS CLI
- Docker Desktop
- WSL 2 on Windows
- Node.js 22+ for generating the Google refresh token

Verify:

```powershell
aws --version
docker --version
node --version
npm --version
```

Docker must also have a working Linux engine:

```powershell
docker version
docker run hello-world
```

On Windows, if WSL is not installed, open PowerShell **as Administrator** and run:

```powershell
wsl --install
```

Restart Windows if required, then verify:

```powershell
wsl --status
wsl -l -v
```

---

## 2. Google Cloud setup for Personal Google Drive

### 2.1 Create/select a Google Cloud project

Open Google Cloud Console and create/select a project, for example:

```text
MySQL RDS Backup
```

### 2.2 Enable Google Drive API

Go to:

```text
APIs & Services
  -> Library
  -> Google Drive API
  -> Enable
```

### 2.3 Configure OAuth consent

Go to:

```text
Google Auth Platform
  -> Branding / Audience
```

Configure the application.

If the application is in **Testing** mode, add the personal Google account that owns the backup folder under:

```text
Audience
  -> Test users
  -> Add users
```

Otherwise Google may return:

```text
Error 403: access_denied
```

### 2.4 Create OAuth client credentials

Create a new OAuth client:

```text
Application type: Desktop app
Name: MySQL Backup OAuth Client
```

Save:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
```

---

## 3. Generate GOOGLE_REFRESH_TOKEN

Install Node dependencies locally:

```powershell
npm install
```

Set your OAuth values in PowerShell:

```powershell
$env:GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
$env:GOOGLE_CLIENT_SECRET="your-client-secret"
```

Generate the token:

```powershell
npm run generate-google-token
```

Open the displayed Google authorization URL and log in using the personal Google account that will store the backups.

After approval, the script prints something like:

```text
GOOGLE_REFRESH_TOKEN=1//xxxxxxxxxxxxxxxxxxxxxxxx
```

Store this token securely.

---

## 4. Google Drive backup folder

Create a folder in your personal Google Drive, for example:

```text
My Drive
└── Database Backups
```

For this project, the selected folder is:

```text
https://drive.google.com/drive/u/0/folders/1SnYYkMtMzqAgGB8tV_yIJwI1yfNNi8Pj
```

Therefore:

```text
GOOGLE_DRIVE_FOLDER_ID=1SnYYkMtMzqAgGB8tV_yIJwI1yfNNi8Pj
```

Only the folder ID is required, not the complete URL.

---

## 5. AWS CLI configuration

Configure AWS CLI:

```powershell
aws configure
```

Verify the authenticated AWS account:

```powershell
aws sts get-caller-identity
```

This project currently uses:

```text
AWS Account ID: 640168439195
AWS Region:     ap-south-1
ECR Repository: mysql-rds-google-drive-backup
```

---

## 6. Create the ECR repository

Create the repository once:

```powershell
aws ecr create-repository `
  --repository-name mysql-rds-google-drive-backup `
  --region ap-south-1
```

If it already exists, this step can be skipped.

ECR repository URI:

```text
640168439195.dkr.ecr.ap-south-1.amazonaws.com/mysql-rds-google-drive-backup
```

---

## 7. Login Docker to Amazon ECR

Make sure Docker Desktop is running first.

Verify:

```powershell
docker info
```

Then log in to ECR:

```powershell
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 640168439195.dkr.ecr.ap-south-1.amazonaws.com
```

Expected output:

```text
Login Succeeded
```

If Docker reports errors involving `dockerDesktopLinuxEngine`, restart Docker Desktop and WSL:

```powershell
wsl --shutdown
```

Then reopen Docker Desktop and verify:

```powershell
docker run hello-world
```

---

## 8. Build the Lambda-compatible Docker image

AWS Lambda requires a single-architecture image with a compatible manifest.

Use **Buildx**, `linux/amd64`, and disable provenance:

```powershell
docker buildx build `
  --platform linux/amd64 `
  --provenance=false `
  --load `
  -t mysql-rds-google-drive-backup:latest .
```

The `--provenance=false` option is important. Without it, Lambda may reject the ECR image with an error similar to:

```text
The image manifest, config or layer media type for the source image is not supported.
```

Verify the local image:

```powershell
docker images
```

---

## 9. Tag the Docker image for ECR

```powershell
docker tag mysql-rds-google-drive-backup:latest 640168439195.dkr.ecr.ap-south-1.amazonaws.com/mysql-rds-google-drive-backup:latest
```

Optional versioned tag:

```powershell
docker tag mysql-rds-google-drive-backup:latest 640168439195.dkr.ecr.ap-south-1.amazonaws.com/mysql-rds-google-drive-backup:v1
```

Versioned tags are recommended because they make deployments easier to trace.

---

## 10. Upload / Push Docker image to ECR

Push `latest`:

```powershell
docker push 640168439195.dkr.ecr.ap-south-1.amazonaws.com/mysql-rds-google-drive-backup:latest
```

Or push a versioned image:

```powershell
docker push 640168439195.dkr.ecr.ap-south-1.amazonaws.com/mysql-rds-google-drive-backup:v1
```

After the push, open:

```text
AWS Console
  -> ECR
  -> Repositories
  -> mysql-rds-google-drive-backup
  -> Images
```

Confirm that the new image/tag appears.

---

## 11. Create the AWS Lambda function

Open:

```text
AWS Console
  -> Lambda
  -> Create function
```

Choose:

```text
Container image
```

Configure:

```text
Function name: mysql-rds-google-drive-backup
Architecture:  x86_64
```

Select the ECR image:

```text
640168439195.dkr.ecr.ap-south-1.amazonaws.com/mysql-rds-google-drive-backup:latest
```

Create the function.

---

## 12. Recommended Lambda settings

For a database currently around 127-130 MB:

```text
Memory:             2048 MB
Timeout:            15 minutes
Architecture:       x86_64
Ephemeral storage:  512 MB
```

Because the backup is streamed, 512 MB of `/tmp` storage is sufficient for the current implementation.

### Public RDS scenario

If the RDS instance is publicly accessible and Lambda is not attached to a VPC, no NAT Gateway is required.

Lambda needs outbound access to:

```text
RDS public endpoint : TCP 3306
Google APIs         : HTTPS 443
```

Make sure the RDS security group allows the required database connectivity.

---

## 13. Lambda environment variables

Go to:

```text
Lambda
  -> Configuration
  -> Environment variables
  -> Edit
```

Add:

```text
DB_HOST=<RDS endpoint>
DB_PORT=3306
DB_USER=<MySQL user>
DB_PASSWORD=<MySQL password>
DB_NAME=<database name>

GOOGLE_CLIENT_ID=<Google OAuth client ID>
GOOGLE_CLIENT_SECRET=<Google OAuth client secret>
GOOGLE_REFRESH_TOKEN=<Google refresh token>
GOOGLE_DRIVE_FOLDER_ID=1SnYYkMtMzqAgGB8tV_yIJwI1yfNNi8Pj
```

Do not commit these secrets to Git.

For production, consider moving sensitive values to AWS Secrets Manager.

---

## 14. Test the Lambda manually

In the Lambda console:

```text
Lambda
  -> Test
  -> Create new event
```

Use:

```json
{}
```

Run the test.

Expected CloudWatch logs include messages similar to:

```text
Starting backup for database: your_database
mysqldump completed successfully.
Backup uploaded successfully to Google Drive.
Google Drive file ID: xxxxxxxxx
```

Then open the configured Google Drive folder and verify the backup file exists.

Backup filename format:

```text
your_database_2026-09-12T02-00-00-000Z.sql.gz
```

---

## 15. Configure EventBridge Scheduler

After a successful manual Lambda test, create the daily schedule.

Go to:

```text
Amazon EventBridge
  -> Scheduler
  -> Create schedule
```

Example daily schedule at 2:00 AM IST:

```text
Schedule expression:
cron(0 2 * * ? *)

Timezone:
Asia/Kolkata
```

Target:

```text
AWS Lambda
```

Function:

```text
mysql-rds-google-drive-backup
```

Use your preferred execution time and timezone.

---

## 16. Updating and redeploying the Lambda

Whenever `index.js`, `Dockerfile`, `package.json`, or another project file changes, rebuild and push a new container image.

### Step 1 - Build

```powershell
docker buildx build `
  --platform linux/amd64 `
  --provenance=false `
  --load `
  -t mysql-rds-google-drive-backup:v2 .
```

### Step 2 - Tag

```powershell
docker tag mysql-rds-google-drive-backup:v2 640168439195.dkr.ecr.ap-south-1.amazonaws.com/mysql-rds-google-drive-backup:v2
```

### Step 3 - Push

```powershell
docker push 640168439195.dkr.ecr.ap-south-1.amazonaws.com/mysql-rds-google-drive-backup:v2
```

### Step 4 - Update Lambda

In AWS Console:

```text
Lambda
  -> mysql-rds-google-drive-backup
  -> Image
  -> Deploy new image
```

Select the new ECR image/tag.

Alternatively with AWS CLI:

```powershell
aws lambda update-function-code `
  --function-name mysql-rds-google-drive-backup `
  --image-uri 640168439195.dkr.ecr.ap-south-1.amazonaws.com/mysql-rds-google-drive-backup:v2 `
  --region ap-south-1
```

Wait for the function to finish updating:

```powershell
aws lambda wait function-updated `
  --function-name mysql-rds-google-drive-backup `
  --region ap-south-1
```

Then test the Lambda again.

---

## 17. Restore a backup using local MySQL tools

Download the `.sql.gz` backup file from Google Drive.

### Linux/macOS

Extract:

```bash
gunzip your_database_2026-09-12T02-00-00-000Z.sql.gz
```

Restore:

```bash
mysql \
  -h <host> \
  -P 3306 \
  -u <user> \
  -p \
  <database> \
  < your_database_2026-09-12T02-00-00-000Z.sql
```

### Windows PowerShell

If you have MySQL client installed:

```powershell
mysql.exe -h <host> -P 3306 -u <user> -p <database> < backup.sql
```

PowerShell's input redirection behavior can vary depending on shell/version. If required, run the restore from `cmd.exe`:

```cmd
mysql.exe -h <host> -P 3306 -u <user> -p database_name < backup.sql
```

---

## 18. Restore a backup using Docker

You can restore without installing MySQL client locally.

### Step 1 - Download and extract the backup

Download the `.sql.gz` file from Google Drive and extract it to a local folder.

Example:

```text
C:\Backups\ohoindiaprod_2026-09-12.sql
```

### Step 2 - Run MySQL client from Docker

From PowerShell, change to the backup directory:

```powershell
cd C:\Backups
```

For PowerShell, pipe the SQL file into a temporary MySQL client container:

```powershell
Get-Content .\ohoindiaprod_2026-09-12.sql -Raw | docker run --rm -i mysql:8.0 mysql -h <RDS_HOST> -P 3306 -u <DB_USER> -p<DB_PASSWORD> <DB_NAME>
```

For very large SQL files, `cmd.exe` redirection is usually more efficient:

```cmd
docker run --rm -i mysql:8.0 mysql -h <RDS_HOST> -P 3306 -u <DB_USER> -p<DB_PASSWORD> <DB_NAME> < ohoindiaprod_2026-09-12.sql
```

> Note: There must be no space between `-p` and the password when passing it inline. For better security, avoid putting passwords in shell history when possible.

### Restore from gzip without manually extracting (Linux/macOS)

```bash
gunzip -c backup.sql.gz | docker run --rm -i mysql:8.0 mysql \
  -h <RDS_HOST> \
  -P 3306 \
  -u <DB_USER> \
  -p<DB_PASSWORD> \
  <DB_NAME>
```

---

## 19. Backup verification

Do not rely only on the successful Lambda response.

Recommended checks:

1. Confirm the `.sql.gz` file appears in Google Drive.
2. Confirm the file size is greater than zero.
3. Download and decompress a sample backup.
4. Check that it contains `CREATE TABLE` / `INSERT` statements as expected.
5. Periodically restore a backup into a temporary/test database.

Example test database:

```sql
CREATE DATABASE backup_restore_test;
```

Then restore the dump into that database and verify important tables and row counts.

---

## 20. MySQL backup options used

The Lambda dump command uses:

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

If the backup user does not have permission to read routines/events, remove those options or grant the required privileges.

---

## 21. Security recommendations

Do not commit the following values to Git:

```text
DB_PASSWORD
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
```

Recommended production improvements:

- Store database credentials in AWS Secrets Manager.
- Store Google OAuth credentials/refresh token in AWS Secrets Manager.
- Restrict MySQL access as much as possible.
- Enable CloudWatch alarms for Lambda failures.
- Keep RDS automated snapshots enabled in addition to logical SQL backups.
- Periodically restore and validate Google Drive backups.
- Define a retention policy if daily backups accumulate over time.

---

## 22. Quick deployment command reference

For normal future deployments:

```powershell
# Login to ECR
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 640168439195.dkr.ecr.ap-south-1.amazonaws.com

# Build Lambda-compatible image
docker buildx build --platform linux/amd64 --provenance=false --load -t mysql-rds-google-drive-backup:v2 .

# Tag
docker tag mysql-rds-google-drive-backup:v2 640168439195.dkr.ecr.ap-south-1.amazonaws.com/mysql-rds-google-drive-backup:v2

# Push
docker push 640168439195.dkr.ecr.ap-south-1.amazonaws.com/mysql-rds-google-drive-backup:v2

# Update Lambda
aws lambda update-function-code --function-name mysql-rds-google-drive-backup --image-uri 640168439195.dkr.ecr.ap-south-1.amazonaws.com/mysql-rds-google-drive-backup:v2 --region ap-south-1

# Wait until update completes
aws lambda wait function-updated --function-name mysql-rds-google-drive-backup --region ap-south-1
```

Then execute a Lambda test and confirm the new backup appears in Google Drive.
