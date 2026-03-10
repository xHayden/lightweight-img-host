import express, { Request, Response, NextFunction, RequestHandler } from "express";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import fs from "fs";
import {
    S3Client, PutObjectCommand, HeadObjectCommand,
    ListObjectsV2Command, DeleteObjectCommand, CopyObjectCommand,
} from "@aws-sdk/client-s3";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { auth } from "express-openid-connect";
import { fileFilter, isSafeFilename } from "./helpers";
import { getContentType } from "./mime";

export interface CreateAppOptions {
    s3?: S3Client;
    bucket?: string;
    cdnUrl?: string;
    uploadsDir?: string;
    allowedUsers?: string;
    uploadApiKey?: string;
    authMiddleware?: RequestHandler;
    disableRateLimit?: boolean;
}

export interface FileRecord {
    name: string;
    url: string;
    size: number | undefined;
    date: Date | undefined;
    source: "local" | "b2";
}

interface S3ErrorLike extends Error {
    $metadata?: { httpStatusCode?: number };
}

function isS3NotFound(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const s3Err = err as S3ErrorLike;
    return s3Err.name === "NotFound" || s3Err.$metadata?.httpStatusCode === 404;
}

export function createApp(options: CreateAppOptions = {}): express.Express {
    const app = express();

    const s3 = options.s3 ?? new S3Client({
        endpoint: process.env["B2_ENDPOINT"],
        region: process.env["B2_REGION"] ?? "us-west-004",
        credentials: {
            accessKeyId: process.env["B2_KEY_ID"]!,
            secretAccessKey: process.env["B2_APP_KEY"]!,
        },
    });
    const B2_BUCKET = options.bucket ?? process.env["B2_BUCKET_NAME"]!;
    const CDN_URL = options.cdnUrl ?? process.env["B2_CDN_URL"]!;
    const uploadsDir = options.uploadsDir ?? path.join(__dirname, "..", "uploads");
    const allowedUserEmails = (options.allowedUsers ?? process.env["ALLOWED_USERS"] ?? "")
        .split(",").map((e) => e.trim().toLowerCase());

    const uploadApiKey = options.uploadApiKey ?? process.env["UPLOAD_API_KEY"] ?? "";

    function safeCompareKeys(a: string, b: string): boolean {
        if (!a || !b) return false;
        const hashA = new Uint8Array(crypto.createHmac("sha256", "compare").update(a).digest());
        const hashB = new Uint8Array(crypto.createHmac("sha256", "compare").update(b).digest());
        return crypto.timingSafeEqual(hashA, hashB);
    }

    function validateCustomName(name: string): string | null {
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) return "Custom name can only contain letters, numbers, hyphens, and underscores.";
        if (name.length > 64) return "Custom name too long (max 64 characters).";
        return null;
    }

    // --- Middleware ---
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
                fontSrc: ["'self'", "https://fonts.gstatic.com"],
                imgSrc: ["'self'", CDN_URL, "data:"],
                objectSrc: ["'none'"],
                frameAncestors: ["'none'"],
            },
        },
        crossOriginEmbedderPolicy: false,
    }));

    if (options.authMiddleware) {
        app.use(options.authMiddleware);
    } else {
        app.use(auth({
            authRequired: false,
            auth0Logout: true,
            secret: process.env["SECRET"]!,
            baseURL: process.env["BASE_URL"]!,
            clientID: process.env["CLIENT_ID"]!,
            issuerBaseURL: process.env["ISSUER_BASE_URL"]!,
        }));
    }

    app.use(express.static(path.join(__dirname, "..", "public")));
    app.set("views", path.join(__dirname, "..", "views"));
    app.set("view engine", "pug");
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    const uploadLimiter = options.disableRateLimit ? null : rateLimit({ windowMs: 15 * 60 * 1000, max: 50, message: "Too many uploads, please try again later." });
    const adminLimiter = options.disableRateLimit ? null : rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
    const adminLimiterMw: RequestHandler = adminLimiter ?? ((_req, _res, next) => next());
    const uploadLimiterMw: RequestHandler = uploadLimiter ?? ((_req, _res, next) => next());

    function requireUploadAuth(req: Request, res: Response, next: NextFunction): void {
        const apiKey = req.headers["x-api-key"];
        if (typeof apiKey === "string" && safeCompareKeys(apiKey, uploadApiKey)) {
            next();
            return;
        }
        if (req.oidc?.isAuthenticated()) {
            next();
            return;
        }
        res.status(401).json({ error: "Unauthorized. Provide x-api-key header or log in." });
    }

    function requireAdmin(req: Request, res: Response, next: NextFunction): void {
        const user = req.oidc?.user;
        if (req.oidc?.isAuthenticated() && user && allowedUserEmails.includes(String(user["email"]).toLowerCase())) {
            next();
            return;
        }
        res.status(401).json({ error: "Unauthorized" });
    }

    // --- Multer (memory storage for B2 upload) ---
    const upload = multer({
        storage: multer.memoryStorage(),
        fileFilter,
        limits: { fileSize: 100 * 1024 * 1024 },
    });

    // --- Routes ---

    app.get("/profile", requireAdmin, (req: Request, res: Response) => {
        res.json(req.oidc.user);
    });

    app.get("/", (_req: Request, res: Response) => {
        res.render("index");
    });

    app.get("/upload", (_req: Request, res: Response) => {
        res.render("upload");
    });

    app.get("/admin", adminLimiterMw, async (req: Request, res: Response) => {
        const user = req.oidc?.user;
        if (!req.oidc?.isAuthenticated() || !user || !allowedUserEmails.includes(String(user["email"]).toLowerCase())) {
            res.redirect("/login");
            return;
        }

        try {
            const localFiles = await fs.promises.readdir(uploadsDir);
            const localUploads: FileRecord[] = await Promise.all(
                localFiles.filter((f) => !f.startsWith(".")).map(async (f): Promise<FileRecord> => {
                    const stat = await fs.promises.stat(path.join(uploadsDir, f));
                    return { name: f, url: `/${f}`, size: stat.size, date: stat.mtime, source: "local" };
                }),
            );

            const b2Uploads: FileRecord[] = [];
            try {
                let continuationToken: string | undefined;
                do {
                    const listResult = await s3.send(new ListObjectsV2Command({
                        Bucket: B2_BUCKET,
                        MaxKeys: 1000,
                        ContinuationToken: continuationToken,
                    }));
                    if (listResult.Contents) {
                        b2Uploads.push(...listResult.Contents.map((obj): FileRecord => ({
                            name: obj.Key!, url: `${CDN_URL}/${obj.Key}`, size: obj.Size, date: obj.LastModified, source: "b2",
                        })));
                    }
                    continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
                } while (continuationToken);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                console.error("Failed to list B2 objects:", message);
            }

            const allUploads = [...b2Uploads, ...localUploads].sort((a, b) => {
                const dateA = a.date ? new Date(a.date).getTime() : 0;
                const dateB = b.date ? new Date(b.date).getTime() : 0;
                return dateB - dateA;
            });
            res.render("admin", { user: req.oidc.user, uploads: allUploads });
        } catch (err: unknown) {
            console.error("Admin error:", err);
            res.status(500).send("Error loading admin panel");
        }
    });

    app.post("/upload", uploadLimiterMw, requireUploadAuth, (req: Request, res: Response) => {
        const singleUpload = upload.single("file-uploaded");

        singleUpload(req, res, async (err?: unknown) => {
            if (req.fileValidationError) {
                res.status(400).json({ error: req.fileValidationError });
                return;
            }
            if (!req.file) {
                res.status(400).json({ error: "Please select a file to upload." });
                return;
            }
            if (err instanceof multer.MulterError) {
                if (err.code === "LIMIT_FILE_SIZE") {
                    res.status(413).json({ error: "File too large. Maximum size is 100MB." });
                    return;
                }
                res.status(400).json({ error: err.message });
                return;
            }
            if (err) {
                const message = err instanceof Error ? err.message : "Upload error";
                res.status(400).json({ error: message });
                return;
            }

            const ext = path.extname(req.file.originalname).toLowerCase();
            const customKey = (req.body["custom-key"] || "").trim();
            let filename: string;

            if (customKey) {
                const validationError = validateCustomName(customKey);
                if (validationError) {
                    res.status(400).json({ error: validationError });
                    return;
                }
                filename = customKey + ext;
            } else {
                filename = crypto.randomBytes(4).toString("hex") + ext;
            }

            try {
                try {
                    await s3.send(new HeadObjectCommand({ Bucket: B2_BUCKET, Key: filename }));
                    res.status(409).json({ error: `Name "${filename}" is already taken. Choose a different name.` });
                    return;
                } catch (headErr: unknown) {
                    if (!isS3NotFound(headErr)) throw headErr;
                }

                await s3.send(new PutObjectCommand({
                    Bucket: B2_BUCKET,
                    Key: filename,
                    Body: req.file.buffer,
                    ContentType: getContentType(filename),
                }));

                const fileUrl = `${CDN_URL}/${filename}`;
                res.redirect(fileUrl);
            } catch (uploadErr: unknown) {
                console.error("B2 upload failed:", uploadErr);
                res.status(500).json({ error: "Upload failed. Please try again." });
            }
        });
    });

    app.post("/admin/delete", adminLimiterMw, requireAdmin, async (req: Request, res: Response) => {
        const { filename, source } = req.body || {};

        if (!filename || !isSafeFilename(filename)) {
            res.status(400).json({ error: "Invalid filename" });
            return;
        }

        try {
            if (source === "b2") {
                await s3.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: filename }));
            } else {
                const filePath = path.join(uploadsDir, filename);
                await fs.promises.unlink(filePath);
            }
            res.json({ success: true });
        } catch (err: unknown) {
            console.error("Delete failed:", err);
            res.status(500).json({ error: "Delete failed" });
        }
    });

    app.post("/admin/rename", adminLimiterMw, requireAdmin, async (req: Request, res: Response) => {
        const { filename, newName, source } = req.body || {};

        if (!filename || !isSafeFilename(filename)) {
            res.status(400).json({ error: "Invalid current filename" });
            return;
        }

        const trimmed = (newName || "").trim();
        const validationError = validateCustomName(trimmed);
        if (!trimmed || validationError) {
            res.status(400).json({ error: validationError || "New name is required." });
            return;
        }

        const ext = path.extname(filename).toLowerCase();
        const newKey = trimmed + ext;

        if (newKey === filename) {
            res.json({ success: true, newName: newKey, newUrl: source === "b2" ? `${CDN_URL}/${newKey}` : `/${newKey}` });
            return;
        }

        try {
            if (source === "b2") {
                try {
                    await s3.send(new HeadObjectCommand({ Bucket: B2_BUCKET, Key: newKey }));
                    res.status(409).json({ error: `"${newKey}" is already taken.` });
                    return;
                } catch (headErr: unknown) {
                    if (!isS3NotFound(headErr)) throw headErr;
                }

                await s3.send(new CopyObjectCommand({
                    Bucket: B2_BUCKET,
                    CopySource: `${B2_BUCKET}/${filename}`,
                    Key: newKey,
                }));
                await s3.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: filename }));

                res.json({ success: true, newName: newKey, newUrl: `${CDN_URL}/${newKey}` });
            } else {
                const newPath = path.join(uploadsDir, newKey);
                if (fs.existsSync(newPath)) {
                    res.status(409).json({ error: `"${newKey}" already exists locally.` });
                    return;
                }
                await fs.promises.rename(path.join(uploadsDir, filename), newPath);
                res.json({ success: true, newName: newKey, newUrl: `/${newKey}` });
            }
        } catch (err: unknown) {
            console.error("Rename failed:", err);
            res.status(500).json({ error: "Rename failed" });
        }
    });

    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
        console.error("Unhandled error:", err);
        res.status(500).json({ error: "Internal server error" });
    });

    return app;
}
