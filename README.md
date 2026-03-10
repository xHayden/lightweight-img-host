# lightweight-img-host

Lightweight file hosting service built with Express and TypeScript. Files are stored in Backblaze B2 and served via Cloudflare CDN, with local storage as a fallback. Includes an admin panel secured by Auth0 for managing uploads (rename, delete).

## Features

- Upload images, PDFs, ZIPs, videos, and text files (with file type validation)
- Custom short URL keys (e.g. `/cat.png`) or auto-generated random filenames
- Backblaze B2 cloud storage with Cloudflare CDN
- Admin panel with file listing, rename, and delete (B2 + local)
- Auth0 authentication for the admin panel (restricted by email allowlist)
- API key authentication for programmatic uploads (`x-api-key` header)
- Rate limiting on upload and admin routes
- Security headers via Helmet (CSP, X-Content-Type-Options, X-Frame-Options, etc.)
- Migration script to move local files to B2

## Setup

```bash
npm install
npm run build
```

### HTTPS (optional)

Create a `cert/` folder with `server.crt` and `server.key`. Without these, the server runs as HTTP.

### Environment variables

Create a `.env` file:

```
SECRET=<auth0-secret>
BASE_URL=<url-of-web-server>
CLIENT_ID=<auth0-client-id>
ISSUER_BASE_URL=<auth0-issuer-url>
ALLOWED_USERS=email1@example.com,email2@example.com

B2_ENDPOINT=<backblaze-s3-endpoint>
B2_REGION=us-west-004
B2_KEY_ID=<backblaze-key-id>
B2_APP_KEY=<backblaze-app-key>
B2_BUCKET_NAME=<bucket-name>
B2_CDN_URL=<cloudflare-cdn-url>

UPLOAD_API_KEY=<api-key-for-programmatic-uploads>
```

## Usage

```bash
# Production
npm start

# Development (with auto-reload and CSS watch)
npm run dev
```

### Programmatic upload

```bash
curl -X POST https://your-host/upload \
  -H "x-api-key: YOUR_API_KEY" \
  -F "file-uploaded=@photo.png" \
  -F "custom-key=my-photo"
```

### Migration (local files to B2)

```bash
# Dry run
npm run migrate

# Actually upload
npx ts-node src/migrate-to-b2.ts --run

# Upload and delete local copies
npx ts-node src/migrate-to-b2.ts --run --delete-local
```

## Tests

```bash
npm test
```

63 tests covering routes, file validation, authentication, admin operations, and security (path traversal, XSS prevention, timing-safe key comparison, MIME sniffing, CSP headers).
