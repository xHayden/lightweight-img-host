import request from "supertest";
import path from "path";
import fs from "fs";
import os from "os";
import express, { Request, Response, NextFunction } from "express";
import { createApp, CreateAppOptions } from "../app";

// Mock S3 client
const mockSend = jest.fn();
const mockS3 = { send: mockSend } as any;

// Mock auth middleware that injects req.oidc
function mockAuth(authenticated = false, user: Record<string, string> = { name: "Test User", email: "admin@test.com" }) {
    return (req: Request, _res: Response, next: NextFunction) => {
        (req as any).oidc = {
            isAuthenticated: () => authenticated,
            user: authenticated ? user : null,
        };
        next();
    };
}

let tmpUploadsDir: string;

beforeEach(() => {
    jest.clearAllMocks();
    tmpUploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-test-"));
});

afterEach(() => {
    fs.rmSync(tmpUploadsDir, { recursive: true, force: true });
});

function mockHeadNotFound(): void {
    const err: any = new Error("Not Found");
    err.name = "NotFound";
    err.$metadata = { httpStatusCode: 404 };
    mockSend.mockRejectedValueOnce(err);
}

function buildApp(authenticated = false, overrides: Partial<CreateAppOptions> = {}): express.Express {
    return createApp({
        s3: mockS3,
        bucket: "test-bucket",
        cdnUrl: "https://cdn.example.com",
        uploadsDir: tmpUploadsDir,
        allowedUsers: "admin@test.com",
        uploadApiKey: "test-api-key-12345",
        disableRateLimit: true,
        authMiddleware: mockAuth(authenticated),
        ...overrides,
    });
}

// ─── Public routes ───────────────────────────────────────────────────

describe("Public routes", () => {
    test("GET / returns 200", async () => {
        const app = buildApp();
        const res = await request(app).get("/");
        expect(res.status).toBe(200);
    });

    test("GET /upload returns 200", async () => {
        const app = buildApp();
        const res = await request(app).get("/upload");
        expect(res.status).toBe(200);
    });
});

// ─── Upload authentication ───────────────────────────────────────────

describe("Upload authentication", () => {
    test("POST /upload without auth returns 401", async () => {
        const app = buildApp(false);
        const res = await request(app)
            .post("/upload")
            .attach("file-uploaded", Buffer.from("fake-image"), "test.png");
        expect(res.status).toBe(401);
    });

    test("POST /upload with valid API key succeeds", async () => {
        mockHeadNotFound();
        mockSend.mockResolvedValueOnce({});
        const app = buildApp(false);
        const res = await request(app)
            .post("/upload")
            .set("x-api-key", "test-api-key-12345")
            .attach("file-uploaded", Buffer.from("fake-image"), "test.png");
        expect(res.status).toBe(302);
        expect(res.headers.location).toMatch(/^https:\/\/cdn\.example\.com\//);
    });

    test("POST /upload with wrong API key returns 401", async () => {
        const app = buildApp(false);
        const res = await request(app)
            .post("/upload")
            .set("x-api-key", "wrong-key")
            .attach("file-uploaded", Buffer.from("fake-image"), "test.png");
        expect(res.status).toBe(401);
    });

    test("POST /upload with empty API key returns 401", async () => {
        const app = buildApp(false);
        const res = await request(app)
            .post("/upload")
            .set("x-api-key", "")
            .attach("file-uploaded", Buffer.from("fake-image"), "test.png");
        expect(res.status).toBe(401);
    });

    test("POST /upload with OIDC auth succeeds", async () => {
        mockHeadNotFound();
        mockSend.mockResolvedValueOnce({});
        const app = buildApp(true);
        const res = await request(app)
            .post("/upload")
            .attach("file-uploaded", Buffer.from("fake-image"), "test.png");
        expect(res.status).toBe(302);
    });
});

// ─── Upload file validation ──────────────────────────────────────────

describe("Upload file validation", () => {
    test("rejects blocked file types (.exe)", async () => {
        const app = buildApp(true);
        const res = await request(app)
            .post("/upload")
            .attach("file-uploaded", Buffer.from("MZ-fake-exe"), "malware.exe");
        expect(res.status).toBe(400);
    });

    test("rejects .sh files", async () => {
        const app = buildApp(true);
        const res = await request(app)
            .post("/upload")
            .attach("file-uploaded", Buffer.from("#!/bin/bash"), "script.sh");
        expect(res.status).toBe(400);
    });

    test("rejects .html files (stored XSS prevention)", async () => {
        const app = buildApp(true);
        const res = await request(app)
            .post("/upload")
            .attach("file-uploaded", Buffer.from("<script>alert(1)</script>"), "evil.html");
        expect(res.status).toBe(400);
    });

    test("accepts PDF files", async () => {
        mockHeadNotFound();
        mockSend.mockResolvedValueOnce({});
        const app = buildApp(true);
        const res = await request(app)
            .post("/upload")
            .attach("file-uploaded", Buffer.from("fake-pdf"), "document.pdf");
        expect(res.status).toBe(302);
    });

    test("accepts ZIP files", async () => {
        mockHeadNotFound();
        mockSend.mockResolvedValueOnce({});
        const app = buildApp(true);
        const res = await request(app)
            .post("/upload")
            .attach("file-uploaded", Buffer.from("fake-zip"), "archive.zip");
        expect(res.status).toBe(302);
    });

    test("returns 400 when no file provided", async () => {
        const app = buildApp(true);
        const res = await request(app).post("/upload");
        expect(res.status).toBe(400);
    });
});

// ─── Upload sends to B2 ─────────────────────────────────────────────

describe("Upload sends to B2", () => {
    test("calls S3 PutObject with correct params", async () => {
        mockHeadNotFound();
        mockSend.mockResolvedValueOnce({});
        const app = buildApp(true);
        await request(app)
            .post("/upload")
            .attach("file-uploaded", Buffer.from("image-data"), "photo.png");

        expect(mockSend).toHaveBeenCalledTimes(2);
        const putCmd = mockSend.mock.calls[1][0];
        expect(putCmd.input.Bucket).toBe("test-bucket");
        expect(putCmd.input.Key).toMatch(/^[a-f0-9]{8}\.png$/);
        expect(putCmd.input.ContentType).toBe("image/png");
    });

    test("returns 500 when B2 upload fails", async () => {
        mockHeadNotFound();
        mockSend.mockRejectedValueOnce(new Error("B2 down"));
        const app = buildApp(true);
        const res = await request(app)
            .post("/upload")
            .attach("file-uploaded", Buffer.from("image-data"), "photo.png");
        expect(res.status).toBe(500);
    });
});

// ─── Admin panel ─────────────────────────────────────────────────────

describe("Admin panel", () => {
    test("GET /admin redirects unauthenticated users", async () => {
        const app = buildApp(false);
        const res = await request(app).get("/admin");
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe("/login");
    });

    test("GET /admin redirects authenticated user not in allowedUsers", async () => {
        const app = createApp({
            s3: mockS3,
            bucket: "test-bucket",
            cdnUrl: "https://cdn.example.com",
            uploadsDir: tmpUploadsDir,
            allowedUsers: "other@test.com",
            uploadApiKey: "test-api-key-12345",
            disableRateLimit: true,
            authMiddleware: mockAuth(true, { name: "Hacker", email: "hacker@evil.com" }),
        });
        const res = await request(app).get("/admin");
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe("/login");
    });

    test("GET /admin shows files for authorized admin", async () => {
        fs.writeFileSync(path.join(tmpUploadsDir, "test-image.png"), "fake");
        mockSend.mockResolvedValueOnce({ Contents: [] });

        const app = buildApp(true);
        const res = await request(app).get("/admin");
        expect(res.status).toBe(200);
        expect(res.text).toContain("test-image.png");
    });

    test("GET /admin includes B2 files", async () => {
        mockSend.mockResolvedValueOnce({
            Contents: [
                { Key: "b2-file.jpg", Size: 1024, LastModified: new Date() },
            ],
        });

        const app = buildApp(true);
        const res = await request(app).get("/admin");
        expect(res.status).toBe(200);
        expect(res.text).toContain("b2-file.jpg");
        expect(res.text).toContain("https://cdn.example.com/b2-file.jpg");
    });
});

// ─── Admin delete ────────────────────────────────────────────────────

describe("Admin delete", () => {
    test("requires authentication", async () => {
        const app = buildApp(false);
        const res = await request(app)
            .post("/admin/delete")
            .send({ filename: "test.png", source: "local" });
        expect(res.status).toBe(401);
    });

    test("rejects path traversal in filename", async () => {
        const app = buildApp(true);
        const res = await request(app)
            .post("/admin/delete")
            .send({ filename: "../../../etc/passwd", source: "local" });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid/i);
    });

    test("rejects dotfiles", async () => {
        const app = buildApp(true);
        const res = await request(app)
            .post("/admin/delete")
            .send({ filename: ".env", source: "local" });
        expect(res.status).toBe(400);
    });

    test("rejects backslash traversal", async () => {
        const app = buildApp(true);
        const res = await request(app)
            .post("/admin/delete")
            .send({ filename: "..\\..\\etc\\passwd", source: "local" });
        expect(res.status).toBe(400);
    });

    test("deletes local file successfully", async () => {
        const testFile = path.join(tmpUploadsDir, "deleteme.png");
        fs.writeFileSync(testFile, "fake");

        const app = buildApp(true);
        const res = await request(app)
            .post("/admin/delete")
            .send({ filename: "deleteme.png", source: "local" });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(fs.existsSync(testFile)).toBe(false);
    });

    test("deletes B2 file successfully", async () => {
        mockSend.mockResolvedValueOnce({});
        const app = buildApp(true);
        const res = await request(app)
            .post("/admin/delete")
            .send({ filename: "b2file.jpg", source: "b2" });
        expect(res.status).toBe(200);
        expect(mockSend).toHaveBeenCalledTimes(1);
        const cmd = mockSend.mock.calls[0][0];
        expect(cmd.input.Key).toBe("b2file.jpg");
    });
});

// ─── Custom key upload ───────────────────────────────────────────────

describe("Custom key upload", () => {
    test("uploads with custom key", async () => {
        mockHeadNotFound();
        mockSend.mockResolvedValueOnce({});
        const app = buildApp(true);
        const res = await request(app)
            .post("/upload")
            .field("custom-key", "cat")
            .attach("file-uploaded", Buffer.from("image-data"), "photo.png");
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe("https://cdn.example.com/cat.png");
        const putCmd = mockSend.mock.calls[1][0];
        expect(putCmd.input.Key).toBe("cat.png");
    });

    test("rejects invalid custom key characters", async () => {
        const app = buildApp(true);
        const res = await request(app)
            .post("/upload")
            .field("custom-key", "bad name!@#")
            .attach("file-uploaded", Buffer.from("image-data"), "photo.png");
        expect(res.status).toBe(400);
    });

    test("rejects custom key over 64 chars", async () => {
        const app = buildApp(true);
        const res = await request(app)
            .post("/upload")
            .field("custom-key", "a".repeat(65))
            .attach("file-uploaded", Buffer.from("image-data"), "photo.png");
        expect(res.status).toBe(400);
    });

    test("returns 409 when custom key already exists", async () => {
        mockSend.mockResolvedValueOnce({});
        const app = buildApp(true);
        const res = await request(app)
            .post("/upload")
            .field("custom-key", "taken")
            .attach("file-uploaded", Buffer.from("image-data"), "photo.png");
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/already taken/i);
    });

    test("auto-generated keys also check for conflicts", async () => {
        mockSend.mockResolvedValueOnce({});
        const app = buildApp(true);
        const res = await request(app)
            .post("/upload")
            .attach("file-uploaded", Buffer.from("image-data"), "photo.png");
        expect(res.status).toBe(409);
    });
});

// ─── Admin rename ────────────────────────────────────────────────────

describe("Admin rename", () => {
    test("requires authentication", async () => {
        const app = buildApp(false);
        const res = await request(app)
            .post("/admin/rename")
            .send({ filename: "old.png", newName: "new", source: "b2" });
        expect(res.status).toBe(401);
    });

    test("rejects invalid current filename", async () => {
        const app = buildApp(true);
        const res = await request(app)
            .post("/admin/rename")
            .send({ filename: "../bad", newName: "good", source: "b2" });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid/i);
    });

    test("rejects invalid new name", async () => {
        const app = buildApp(true);
        const res = await request(app)
            .post("/admin/rename")
            .send({ filename: "old.png", newName: "bad name!!", source: "b2" });
        expect(res.status).toBe(400);
    });

    test("renames B2 file (copy + delete)", async () => {
        mockHeadNotFound();
        mockSend.mockResolvedValueOnce({});
        mockSend.mockResolvedValueOnce({});
        const app = buildApp(true);
        const res = await request(app)
            .post("/admin/rename")
            .send({ filename: "old.png", newName: "new", source: "b2" });
        expect(res.status).toBe(200);
        expect(res.body.newName).toBe("new.png");
        expect(res.body.newUrl).toBe("https://cdn.example.com/new.png");
        expect(mockSend).toHaveBeenCalledTimes(3);
    });

    test("returns 409 if new B2 key is taken", async () => {
        mockSend.mockResolvedValueOnce({});
        const app = buildApp(true);
        const res = await request(app)
            .post("/admin/rename")
            .send({ filename: "old.png", newName: "taken", source: "b2" });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/already taken/i);
    });

    test("renames local file", async () => {
        fs.writeFileSync(path.join(tmpUploadsDir, "old.png"), "data");
        const app = buildApp(true);
        const res = await request(app)
            .post("/admin/rename")
            .send({ filename: "old.png", newName: "new", source: "local" });
        expect(res.status).toBe(200);
        expect(res.body.newName).toBe("new.png");
        expect(fs.existsSync(path.join(tmpUploadsDir, "new.png"))).toBe(true);
        expect(fs.existsSync(path.join(tmpUploadsDir, "old.png"))).toBe(false);
    });

    test("returns 409 if local file already exists", async () => {
        fs.writeFileSync(path.join(tmpUploadsDir, "old.png"), "data");
        fs.writeFileSync(path.join(tmpUploadsDir, "taken.png"), "other");
        const app = buildApp(true);
        const res = await request(app)
            .post("/admin/rename")
            .send({ filename: "old.png", newName: "taken", source: "local" });
        expect(res.status).toBe(409);
    });

    test("no-op when renaming to same name", async () => {
        const app = buildApp(true);
        const res = await request(app)
            .post("/admin/rename")
            .send({ filename: "cat.png", newName: "cat", source: "b2" });
        expect(res.status).toBe(200);
        expect(res.body.newName).toBe("cat.png");
        expect(mockSend).not.toHaveBeenCalled();
    });
});

// ─── Security headers ────────────────────────────────────────────────

describe("Security headers", () => {
    test("includes helmet security headers", async () => {
        const app = buildApp();
        const res = await request(app).get("/");
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.headers["x-frame-options"]).toBeDefined();
    });

    test("sets content-security-policy", async () => {
        const app = buildApp();
        const res = await request(app).get("/");
        expect(res.headers["content-security-policy"]).toBeDefined();
        expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    });

    test("sets X-Content-Type-Options to prevent MIME sniffing", async () => {
        const app = buildApp();
        const res = await request(app).get("/");
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });
});

// ─── Security: timing-safe API key comparison ────────────────────────

describe("API key security", () => {
    test("does not allow authentication with empty API key even if server key is empty", async () => {
        const app = createApp({
            s3: mockS3,
            bucket: "test-bucket",
            cdnUrl: "https://cdn.example.com",
            uploadsDir: tmpUploadsDir,
            allowedUsers: "admin@test.com",
            uploadApiKey: "",
            disableRateLimit: true,
            authMiddleware: mockAuth(false),
        });
        const res = await request(app)
            .post("/upload")
            .set("x-api-key", "")
            .attach("file-uploaded", Buffer.from("fake"), "test.png");
        expect(res.status).toBe(401);
    });
});

// ─── Profile route ───────────────────────────────────────────────────

describe("Profile route", () => {
    test("GET /profile requires admin auth", async () => {
        const app = buildApp(false);
        const res = await request(app).get("/profile");
        expect(res.status).toBe(401);
    });

    test("GET /profile returns user info for admin", async () => {
        const app = buildApp(true);
        const res = await request(app).get("/profile");
        expect(res.status).toBe(200);
        expect(res.body.email).toBe("admin@test.com");
    });
});

// ─── Error handler ───────────────────────────────────────────────────

describe("Error handling", () => {
    test("unknown routes return 404 and do not leak stack traces", async () => {
        const app = buildApp();
        const res = await request(app).get("/nonexistent-route");
        expect(res.status).toBe(404);
        // Should not expose internal paths or stack traces
        expect(res.text).not.toMatch(/at\s+\w+\s+\(/); // no stack frames
        expect(res.text).not.toContain(__dirname);
    });
});
