// Cloudflare Worker for img.hayden.gg
// Routes file-slug requests to the CDN (files.hayden.gg) so images
// can be embedded directly without a 301 redirect.
// App routes (/upload, /admin, etc.) pass through to the VPS origin.

const CDN_HOST = "files.hayden.gg";

const APP_ROUTES = [
  "/upload",
  "/admin",
  "/profile",
  "/callback",
  "/logout",
  "/css",
  "/api",
  "/.well-known",
];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Pass app routes through to VPS origin
    if (path === "/" || APP_ROUTES.some((route) => path.startsWith(route))) {
      return fetch(request);
    }

    // For file-slug paths, fetch from CDN instead of redirecting
    const cdnUrl = new URL(path, `https://${CDN_HOST}`);
    const cdnResponse = await fetch(cdnUrl, { cf: { cacheEverything: true } });

    // If CDN returns 404, fall through to origin
    if (cdnResponse.status === 404) {
      return fetch(request);
    }

    // Return CDN response with CORS header
    const response = new Response(cdnResponse.body, cdnResponse);
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("X-Served-By", "img-worker");
    return response;
  },
};
