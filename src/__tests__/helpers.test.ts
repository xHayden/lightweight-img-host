import { fileFilter, isSafeFilename } from "../helpers";
import type { Request } from "express";
import type { FileFilterCallback } from "multer";

function callFilter(
    filename: string,
): Promise<{ err: Error | null; accepted: boolean | undefined; validationError?: string }> {
    return new Promise((resolve) => {
        const req = {} as Request;
        const file = { originalname: filename } as Express.Multer.File;
        fileFilter(req, file, ((err: Error | null, accepted?: boolean) => {
            resolve({ err, accepted, validationError: req.fileValidationError });
        }) as FileFilterCallback);
    });
}

describe("fileFilter", () => {
    test("accepts common image files", async () => {
        for (const name of ["photo.jpg", "image.png", "anim.gif", "pic.jpeg", "doc.webp"]) {
            const { accepted } = await callFilter(name);
            expect(accepted).toBe(true);
        }
    });

    test("accepts non-image files (pdf, zip, txt)", async () => {
        for (const name of ["report.pdf", "archive.zip", "notes.txt", "data.csv"]) {
            const { accepted } = await callFilter(name);
            expect(accepted).toBe(true);
        }
    });

    test("blocks dangerous executable extensions", async () => {
        const dangerous = ["malware.exe", "script.sh", "hack.bat", "payload.ps1", "lib.dll", "run.cmd", "test.vbs"];
        for (const name of dangerous) {
            const { err, validationError } = await callFilter(name);
            expect(err).toBeTruthy();
            expect(validationError).toMatch(/not allowed/i);
        }
    });

    test("blocks .js files", async () => {
        const { err } = await callFilter("script.js");
        expect(err).toBeTruthy();
    });

    test("blocks .html files (XSS vector)", async () => {
        const { err } = await callFilter("page.html");
        expect(err).toBeTruthy();
    });

    test("blocks .svg files (XSS vector)", async () => {
        const { err } = await callFilter("image.svg");
        expect(err).toBeTruthy();
    });

    test("handles case-insensitive extensions", async () => {
        const { accepted } = await callFilter("PHOTO.JPG");
        expect(accepted).toBe(true);
    });

    test("blocks double extensions used to bypass filters", async () => {
        const { err } = await callFilter("image.png.exe");
        expect(err).toBeTruthy();
    });
});

describe("isSafeFilename", () => {
    test("accepts valid filenames", () => {
        expect(isSafeFilename("abc123.png")).toBe(true);
        expect(isSafeFilename("my-file_v2.tar.gz")).toBe(true);
        expect(isSafeFilename("a0b1c2d3e4f5.jpg")).toBe(true);
    });

    test("rejects path traversal attempts", () => {
        expect(isSafeFilename("../etc/passwd")).toBe(false);
        expect(isSafeFilename("..\\windows\\system32")).toBe(false);
        expect(isSafeFilename("foo/../../bar")).toBe(false);
    });

    test("rejects dotfiles", () => {
        expect(isSafeFilename(".env")).toBe(false);
        expect(isSafeFilename(".htaccess")).toBe(false);
    });

    test("rejects empty or non-string inputs", () => {
        expect(isSafeFilename("")).toBe(false);
        expect(isSafeFilename(null)).toBe(false);
        expect(isSafeFilename(undefined)).toBe(false);
        expect(isSafeFilename(123)).toBe(false);
    });

    test("rejects filenames with special characters (command injection)", () => {
        expect(isSafeFilename("file name.png")).toBe(false);
        expect(isSafeFilename("file;rm -rf.png")).toBe(false);
        expect(isSafeFilename("file$(cmd).png")).toBe(false);
        expect(isSafeFilename("file`whoami`.png")).toBe(false);
        expect(isSafeFilename("file|cat /etc/passwd.png")).toBe(false);
    });

    test("rejects null bytes", () => {
        expect(isSafeFilename("file\0.png")).toBe(false);
    });
});
