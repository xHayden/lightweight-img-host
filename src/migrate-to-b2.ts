#!/usr/bin/env node

/**
 * Migration script: uploads all local files from /uploads/ to Backblaze B2,
 * preserving their original filenames so existing URLs work via CDN.
 *
 * Usage:
 *   npx ts-node src/migrate-to-b2.ts              # dry run (default)
 *   npx ts-node src/migrate-to-b2.ts --run        # actually upload
 *   npx ts-node src/migrate-to-b2.ts --run --delete-local  # upload then delete local copies
 *
 * Requires env vars: B2_ENDPOINT, B2_KEY_ID, B2_APP_KEY, B2_BUCKET_NAME
 * (loaded from .env automatically)
 */

import "dotenv/config";
import path from "path";
import fs from "fs";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getContentType } from "./mime";

const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const CONCURRENCY = 5;

type MigrationResult = "uploaded" | "skipped" | "deleted" | "dry";

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const dryRun = !args.includes("--run");
    const deleteLocal = args.includes("--delete-local");

    const required = ["B2_ENDPOINT", "B2_KEY_ID", "B2_APP_KEY", "B2_BUCKET_NAME"] as const;
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
        console.error(`Missing env vars: ${missing.join(", ")}`);
        console.error("Set them in .env or export them.");
        process.exit(1);
    }

    const s3 = new S3Client({
        endpoint: process.env["B2_ENDPOINT"],
        region: process.env["B2_REGION"] ?? "us-west-004",
        credentials: {
            accessKeyId: process.env["B2_KEY_ID"]!,
            secretAccessKey: process.env["B2_APP_KEY"]!,
        },
    });
    const bucket = process.env["B2_BUCKET_NAME"]!;

    const files = fs.readdirSync(UPLOADS_DIR).filter((f) => !f.startsWith("."));
    console.log(`Found ${files.length} files in ${UPLOADS_DIR}`);

    if (dryRun) {
        console.log("\n--- DRY RUN (pass --run to actually upload) ---\n");
    }

    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    let deleted = 0;

    for (let i = 0; i < files.length; i += CONCURRENCY) {
        const batch = files.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
            batch.map(async (filename): Promise<MigrationResult> => {
                const filePath = path.join(UPLOADS_DIR, filename);
                const stat = fs.statSync(filePath);
                const sizeKB = (stat.size / 1024).toFixed(1);

                if (dryRun) {
                    console.log(`  [dry-run] Would upload: ${filename} (${sizeKB} KB)`);
                    return "dry";
                }

                try {
                    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: filename }));
                    console.log(`  [skip] Already in B2: ${filename}`);
                    return "skipped";
                } catch {
                    // Not found — proceed with upload
                }

                const body = fs.readFileSync(filePath);
                const contentType = getContentType(filename);

                await s3.send(new PutObjectCommand({
                    Bucket: bucket,
                    Key: filename,
                    Body: body,
                    ContentType: contentType,
                }));

                console.log(`  [ok] Uploaded: ${filename} (${sizeKB} KB, ${contentType})`);

                if (deleteLocal) {
                    fs.unlinkSync(filePath);
                    console.log(`  [deleted] Local copy removed: ${filename}`);
                    return "deleted";
                }

                return "uploaded";
            }),
        );

        for (const result of results) {
            if (result.status === "fulfilled") {
                if (result.value === "uploaded") uploaded++;
                else if (result.value === "skipped") skipped++;
                else if (result.value === "deleted") { uploaded++; deleted++; }
            } else {
                failed++;
                console.error(`  [error] ${result.reason.message}`);
            }
        }
    }

    console.log("\n--- Summary ---");
    if (dryRun) {
        console.log(`${files.length} files would be uploaded (dry run)`);
        console.log("Run with --run to execute.");
    } else {
        console.log(`Uploaded: ${uploaded}`);
        console.log(`Skipped (already in B2): ${skipped}`);
        console.log(`Failed: ${failed}`);
        if (deleteLocal) console.log(`Local copies deleted: ${deleted}`);
    }

    if (uploaded > 0 && !deleteLocal) {
        console.log("\nLocal files kept. Run with --run --delete-local to remove them after verifying.");
    }

    if (uploaded > 0 || skipped > 0) {
        console.log("\nAfter migration, you can rely entirely on the Cloudflare CDN URL for serving files.");
    }
}

if (require.main === module) {
    main().catch((err: unknown) => {
        console.error("Migration failed:", err);
        process.exit(1);
    });
}

export { getContentType as getMimeType };
