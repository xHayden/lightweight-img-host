import path from "path";
import type { Request } from "express";
import type { FileFilterCallback } from "multer";

const ALLOWED_EXTENSIONS = new Set<string>([
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff",
    ".pdf", ".zip",
    ".mp4", ".mov", ".avi", ".webm",
    ".txt", ".csv", ".json",
]);

export const fileFilter = (
    req: Request,
    file: Express.Multer.File,
    cb: FileFilterCallback,
): void => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        req.fileValidationError = "This file type is not allowed.";
        return cb(new Error("This file type is not allowed."));
    }
    cb(null, true);
};

export const isSafeFilename = (filename: unknown): boolean => {
    if (!filename || typeof filename !== "string") return false;
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) return false;
    if (filename.startsWith(".")) return false;
    return /^[a-zA-Z0-9._-]+$/.test(filename);
};
