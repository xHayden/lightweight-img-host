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
BASE_URL=https://img.hayden.gg
CLIENT_ID=<auth0-client-id>
ISSUER_BASE_URL=https://your-tenant.us.auth0.com
ALLOWED_USERS=email1@example.com,email2@example.com

B2_ENDPOINT=https://s3.us-west-004.backblazeb2.com
B2_REGION=us-west-004
B2_KEY_ID=<backblaze-key-id>
B2_APP_KEY=<backblaze-app-key>
B2_BUCKET_NAME=my-images
B2_CDN_URL=https://files.hayden.gg

UPLOAD_API_KEY=<api-key-for-programmatic-uploads>
```

### Backblaze B2 setup

1. Create a [Backblaze](https://www.backblaze.com) account (10 GB storage free).
2. Go to **B2 Cloud Storage > Buckets > Create a Bucket**.
3. Name it (e.g., `my-images`). This is globally unique and permanent.
4. Set **Files in Bucket are: Public**.
5. Click any uploaded file to find the **friendly URL hostname** (e.g., `f003.backblazeb2.com`). You'll need this for the Cloudflare CNAME.
6. Go to **App Keys > Add a New Application Key**, restrict it to your bucket, and save the `keyID` (`B2_KEY_ID`) and `applicationKey` (`B2_APP_KEY`).
7. Find the S3-compatible endpoint and region on your bucket details page — these become `B2_ENDPOINT` and `B2_REGION`.

#### CORS rules

Configure via the B2 CLI:

```bash
b2 bucket update --cors-rules '[
  {
    "corsRuleName": "allowAll",
    "allowedOrigins": ["*"],
    "allowedHeaders": ["*"],
    "allowedOperations": ["b2_download_file_by_name"],
    "exposeHeaders": ["Content-Length", "Content-Type"],
    "maxAgeSeconds": 3600
  }
]' my-images allPublic
```

### Cloudflare setup

The VPS runs at `img.hayden.gg` and handles uploads/admin. Files are served from `files.hayden.gg`, which is Cloudflare proxying the B2 bucket. Egress from B2 through Cloudflare is free via the [Bandwidth Alliance](https://www.cloudflare.com/bandwidth-alliance/).

```
User → img.hayden.gg (VPS/Express) → uploads to B2
User → files.hayden.gg (Cloudflare CDN → B2) → serves files
```

#### 1. DNS record for `files.hayden.gg`

Create a **CNAME** record in Cloudflare:

| Type | Name | Target | Proxy |
|------|------|--------|-------|
| CNAME | `files` | `f003.backblazeb2.com` | Proxied (orange cloud ON) |

Replace `f003.backblazeb2.com` with your actual B2 friendly hostname.

Set **SSL/TLS > Overview** to **Full (strict)**.

#### 2. Transform rule (URL rewrite)

This rewrites `files.hayden.gg/photo.jpg` to the actual B2 path `f003.backblazeb2.com/file/my-images/photo.jpg`.

Go to **Rules > Transform Rules > Rewrite URL > Create rule**:

- **Name**: `B2 URL Rewrite`
- **Expression** (edit expression):
  ```
  (http.host eq "files.hayden.gg" and not starts_with(http.request.uri.path, "/file/my-images"))
  ```
- **Path** → Rewrite to → Dynamic:
  ```
  concat("/file/my-images", http.request.uri.path)
  ```
- **Query**: Preserve

#### 3. Response header rules

Go to **Rules > Transform Rules > Modify Response Header > Create rule**:

- **Expression**: `(http.host eq "files.hayden.gg")`

**Remove** these headers (hides B2 internals):
- `x-bz-file-name`
- `x-bz-file-id`
- `x-bz-content-sha1`
- `x-bz-upload-timestamp`
- `x-bz-info-src_last_modified_millis`

**Set** these headers:
- `cache-control` → `public, max-age=31536000, immutable`
- `Access-Control-Allow-Origin` → `*`

#### 4. Cache rule (optional)

Go to **Rules > Cache Rules > Create rule**:

- **Expression**: `(http.host eq "files.hayden.gg")`
- **Cache eligibility**: Eligible for cache
- **Edge TTL**: 7 days
- **Browser TTL**: 1 year

#### 5. Cloudflare Worker for direct image embedding on the upload domain

The upload domain returns a 301 redirect to the CDN domain for file requests. Most document editors and chat apps don't follow redirects when embedding images, so embedded links appear broken.

A Cloudflare Worker fixes this by routing file-slug paths directly to the CDN at the edge (zero VPS bandwidth), while passing app routes (`/upload`, `/admin`, etc.) through to the VPS origin. See [`cloudflare-worker.js`](cloudflare-worker.js).

To deploy:

1. Go to **Workers & Pages > Create > Create Worker**.
2. Paste the contents of `cloudflare-worker.js` and deploy.
3. Go to your domain's **Workers Routes** and add a route:
   - **Route**: `img.example.com/*`
   - **Worker**: select the worker you just created

Responses are cached at the edge via `cacheEverything`, so the worker only fetches from the CDN on cache misses.

#### Verify

```bash
curl -I https://files.hayden.gg/photo.jpg
```

You should see `cf-cache-status: HIT` (on second request), your `cache-control` header, and no `x-bz-*` headers.

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

### Screenshot sync (macOS)

Auto-uploads new screenshots and copies the URL to your clipboard.

```bash
pip3 install watchdog pyperclip requests
```

Run it:

```bash
UPLOAD_API_KEY=your-api-key python3 screenshot_sync.py
```

| Variable | Default | Description |
|---|---|---|
| `UPLOAD_API_KEY` | *(required)* | Same key as the server's `UPLOAD_API_KEY` |
| `SCREENSHOT_DIR` | `~/Documents/Screenshots` | Directory to watch for new files |
| `UPLOAD_URL` | `https://img.hayden.gg/` | Your image host URL |

Supports `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, and `.pdf`. Uses macOS FSEvents for native file watching with debounce and retry logic. Can be set up as a LaunchAgent for auto-start at login.

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
