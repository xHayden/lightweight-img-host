import "dotenv/config";
import path from "path";
import http from "http";
import https from "https";
import fs from "fs";
import { createApp } from "./app";

const requiredVars = [
    "SECRET", "BASE_URL", "CLIENT_ID", "ISSUER_BASE_URL",
    "B2_ENDPOINT", "B2_KEY_ID", "B2_APP_KEY", "B2_BUCKET_NAME",
    "B2_CDN_URL", "UPLOAD_API_KEY",
] as const;

const missing = requiredVars.filter((v) => !process.env[v]);
if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
}

const app = createApp();

const HTTP_PORT = process.env["PORT"] ?? 80;
const HTTPS_PORT = process.env["HTTPS_PORT"] ?? 443;

let devEnv = false;
let credentials: { key: string; cert: string } | undefined;

try {
    const privateKey = fs.readFileSync(path.join(__dirname, "..", "cert/server.key"), "utf8");
    const certificate = fs.readFileSync(path.join(__dirname, "..", "cert/server.crt"), "utf8");
    credentials = { key: privateKey, cert: certificate };
} catch {
    console.log("Credentials not found. Running development environment.");
    devEnv = true;
}

function shutdown(server: http.Server): void {
    console.log("Shutting down gracefully...");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
}

const server = devEnv
    ? http.createServer(app).listen(HTTP_PORT, () => console.log(`Server running as HTTP on port ${HTTP_PORT}`))
    : https.createServer(credentials!, app).listen(HTTPS_PORT, () => console.log(`Server running as HTTPS on port ${HTTPS_PORT}`));

process.on("SIGTERM", () => shutdown(server));
process.on("SIGINT", () => shutdown(server));
